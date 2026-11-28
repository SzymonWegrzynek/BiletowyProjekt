import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { reservationsCollection } from "../db.ts";
import {
  waitlistOffersCollection,
  sendPendingOfferMails,
} from "./send-offer-mail.ts";

export class WebhookConfigurationError extends Error {}
export function verifyResendWebhook(
  body: string,
  headers: Headers,
  secret: string | undefined,
  now = Date.now(),
) {
  if (
    !secret?.startsWith("whsec_") ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(secret.slice(6))
  )
    throw new WebhookConfigurationError(
      "Brak poprawnego RESEND_WEBHOOK_SECRET",
    );
  const key = Buffer.from(secret.slice(6), "base64");
  if (!key.length) throw new WebhookConfigurationError("Pusty sekret");
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (
    !id ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !signatures ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300
  )
    throw new Error("Nieprawidłowy podpis lub czas webhooka");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();
  const valid = signatures.split(/\s+/).some((signature) => {
    if (!signature.startsWith("v1,")) return false;
    const encoded = signature.slice(3);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const actual = Buffer.from(encoded, "base64");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
  if (!valid) throw new Error("Nieprawidłowy podpis webhooka");
  return id;
}

type Dependencies = {
  // B musi wykonać to atomowo i idempotentnie, sprawdzając status rezerwacji.
  markOfferMissed: (waitlistId: string) => Promise<unknown>;
  flush?: (eventId: string) => Promise<unknown>;
};
const eventSchema = z.object({
  type: z.string(),
  data: z.unknown().optional(),
});

// Gotowy handler do podłączenia w route.ts, gdy istnieje prawdziwe markOfferMissed.
// Brak fikcyjnego backendu i brak endpointu, który potwierdza niewykonaną zmianę.
export function createResendWebhookHandler({
  markOfferMissed,
  flush = sendPendingOfferMails,
}: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    let body: string;
    let event: z.infer<typeof eventSchema>;
    let messageId: string | undefined;
    try {
      body = await request.text();
      if (body.length > 1_000_000) throw new Error("Za duże zdarzenie");
      verifyResendWebhook(
        body,
        request.headers,
        process.env.RESEND_WEBHOOK_SECRET,
      );
      event = eventSchema.parse(JSON.parse(body));
      if (["email.bounced", "email.delivered"].includes(event.type))
        messageId = z
          .object({ email_id: z.string().min(1) })
          .parse(event.data).email_id;
    } catch (error) {
      const configError = error instanceof WebhookConfigurationError;
      return Response.json(
        {
          error: configError
            ? "Webhook poczty nie jest skonfigurowany"
            : "Nieprawidłowy webhook",
          code: configError ? "MAIL_UNAVAILABLE" : "VALIDATION_ERROR",
        },
        { status: configError ? 503 : 400 },
      );
    }
    if (!["email.bounced", "email.delivered"].includes(event.type))
      return Response.json({ received: true });
    try {
      const collection = waitlistOffersCollection();
      const offer = await collection.findOne({
        "mail.messageId": messageId!,
      });
      if (!offer) return Response.json({ received: true });
      const filter = {
        _id: offer._id,
        reservationId: offer.reservationId,
        "mail.messageId": messageId!,
      };
      if (event.type === "email.delivered") {
        await collection.updateOne(
          { ...filter, "mail.status": "sent" },
          { $set: { "mail.status": "delivered" } },
        );
      } else if (
        offer.status === "offered" &&
        offer.offerExpiresAt &&
        offer.offerExpiresAt > new Date() &&
        offer.reservationId &&
        ObjectId.isValid(offer.reservationId) &&
        !offer.mail?.bounceHandledAt
      ) {
        const reservation = await reservationsCollection().findOne({
          _id: new ObjectId(offer.reservationId),
        });
        if (reservation?.status !== "held")
          return Response.json({ received: true });
        const recorded = await collection.updateOne(
          {
            ...filter,
            status: "offered",
            offerExpiresAt: { $gt: new Date() },
            "mail.status": { $in: ["sent", "delivered", "bounced"] },
          },
          { $set: { "mail.status": "bounced" } },
        );
        // matchedCount, nie modifiedCount: ponowienie po awarii B ma być obsłużone.
        if (recorded.matchedCount) {
          await markOfferMissed(offer._id.toHexString());
          await collection.updateOne(filter, {
            $set: { "mail.bounceHandledAt": new Date() },
          });
          // B już przesunął kolejkę; awaria poczty zostawia jej outbox do retry.
          try {
            await flush(offer.eventId);
          } catch {
            /* następny wyzwalacz B ponowi */
          }
        }
      }
      return Response.json({ received: true });
    } catch {
      return Response.json(
        {
          error: "Nie udało się przetworzyć zdarzenia poczty",
          code: "WEBHOOK_FAILED",
        },
        { status: 500 },
      );
    }
  };
}
