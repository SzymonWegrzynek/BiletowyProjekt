import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb, eventsCollection, reservationsCollection } from "../db.ts";
import { waitlistIdSchema } from "../waitlist.ts";
import {
  buildOfferEmail,
  offerMailKey,
  type WaitlistOffer,
  type OfferMailState,
} from "./offer-mail.ts";
import {
  allowedRecipient,
  resendConfig,
  sendResendRequest,
  ResendSendError,
} from "./resend.ts";

export function waitlistOffersCollection() {
  return getDb().collection<WaitlistOffer>("waitlist");
}
export type OfferMailResult =
  "sent" | "skipped" | "wait" | "failed" | "blocked" | "already-sent";
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

// C zapisuje wyłącznie mail.*. Tworzenie, wygaszanie i przesuwanie oferty to B.
export async function sendOfferMail(id: string): Promise<OfferMailResult> {
  if (!waitlistIdSchema.safeParse(id).success) return "skipped";
  const config = resendConfig();
  if (!config || !process.env.APP_URL) return "skipped";
  const collection = waitlistOffersCollection();
  const _id = new ObjectId(id);
  const offer = await collection.findOne({ _id });
  const now = new Date();
  if (
    !offer ||
    offer.status !== "offered" ||
    !offer.reservationId ||
    !waitlistIdSchema.safeParse(offer.reservationId).success ||
    !offer.offerExpiresAt ||
    offer.offerExpiresAt <= now ||
    !offer.mail
  )
    return "skipped";
  const previous = offer.mail;
  if (["sent", "delivered", "bounced"].includes(previous.status))
    return "already-sent";
  if (
    (previous.leaseUntil && previous.leaseUntil > now) ||
    (previous.nextAttemptAt && previous.nextAttemptAt > now)
  )
    return "wait";
  if (
    previous.retryable === false ||
    (previous.attempts ?? 0) >= 5 ||
    (previous.firstAttemptAt &&
      now.getTime() - previous.firstAttemptAt.getTime() >= RETRY_WINDOW_MS)
  )
    return "blocked";
  if (!allowedRecipient(offer.email, config.live)) return "skipped";
  const reservation = await reservationsCollection().findOne({
    _id: new ObjectId(offer.reservationId),
  });
  const event = await eventsCollection().findOne({ _id: offer.eventId });
  if (!reservation || !event) return "skipped";
  const email = buildOfferEmail(
    offer,
    reservation,
    event,
    process.env.APP_URL,
    now,
  );
  if (!email) return "skipped";
  // Retry nigdy nie zmienia nadawcy, treści ani klucza po niepewnym wyniku.
  if (
    (previous.attempts ?? 0) > 0 &&
    (!previous.requestBody || !previous.operationId || !previous.firstAttemptAt)
  )
    return "blocked";
  const operation: OfferMailState = {
    ...previous,
    status: "pending",
    attemptToken: randomUUID(),
    attempts: (previous.attempts ?? 0) + 1,
    firstAttemptAt: previous.firstAttemptAt ?? now,
    operationId: previous.operationId ?? offerMailKey(offer),
    requestBody:
      previous.requestBody ?? JSON.stringify({ from: config.from, ...email }),
    leaseUntil: new Date(now.getTime() + 30_000),
  };
  const claimed = await collection.updateOne(
    {
      _id,
      status: "offered",
      reservationId: offer.reservationId,
      offerExpiresAt: { $gt: now },
      mail: previous,
    },
    { $set: { mail: operation } },
  );
  if (claimed.modifiedCount !== 1) return "wait";
  const owns = {
    _id,
    reservationId: offer.reservationId,
    "mail.attemptToken": operation.attemptToken,
    "mail.status": "pending" as const,
  };
  let messageId: string;
  try {
    messageId = await sendResendRequest(
      operation.requestBody!,
      operation.operationId!,
      { timeoutMs: 5000 },
    );
  } catch (error) {
    const retryable = error instanceof ResendSendError && error.retryable;
    const backoff = Math.max(
      5000 * 2 ** (operation.attempts! - 1),
      error instanceof ResendSendError ? (error.retryAfterMs ?? 0) : 0,
    );
    await collection.updateOne(owns, {
      $set: {
        "mail.status": "failed",
        "mail.retryable": retryable,
        "mail.lastError":
          error instanceof ResendSendError
            ? error.kind
            : "configuration_or_payload",
        "mail.leaseUntil": new Date(),
        "mail.nextAttemptAt": new Date(Date.now() + backoff),
      },
    });
    return retryable ? "failed" : "blocked";
  }
  // Zapis po API może się nie udać; retry po lease odzyska ten sam messageId.
  await collection.updateOne(owns, {
    $set: {
      "mail.status": "sent",
      "mail.messageId": messageId,
      "mail.acceptedAt": new Date(),
    },
  });
  return "sent";
}

// Do wywołania przez wyzwalacze B po COMMIT. Bez pętli w tle i bez crona.
export async function sendPendingOfferMails(eventId?: string, limit = 3) {
  const now = new Date();
  const offers = await waitlistOffersCollection()
    .find(
      {
        status: "offered",
        ...(eventId ? { eventId } : {}),
        offerExpiresAt: { $gt: now },
        "mail.status": { $in: ["pending", "failed"] },
        "mail.retryable": { $ne: false },
        $and: [
          {
            $or: [
              { "mail.leaseUntil": { $exists: false } },
              { "mail.leaseUntil": { $lte: now } },
            ],
          },
          {
            $or: [
              { "mail.nextAttemptAt": { $exists: false } },
              { "mail.nextAttemptAt": { $lte: now } },
            ],
          },
          {
            $or: [
              { "mail.attempts": { $exists: false } },
              { "mail.attempts": { $lt: 5 } },
            ],
          },
          {
            $or: [
              { "mail.firstAttemptAt": { $exists: false } },
              {
                "mail.firstAttemptAt": {
                  $gt: new Date(now.getTime() - RETRY_WINDOW_MS),
                },
              },
            ],
          },
        ],
      },
      { projection: { _id: 1 } },
    )
    .sort({ joinedAt: 1, _id: 1 })
    .limit(Math.max(1, Math.min(3, Math.floor(limit) || 1)))
    .toArray();
  const results: OfferMailResult[] = [];
  for (const offer of offers) {
    try {
      results.push(await sendOfferMail(offer._id.toHexString()));
    } catch {
      results.push("failed");
    }
  }
  return results;
}
