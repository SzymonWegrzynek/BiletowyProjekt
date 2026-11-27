import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { eventsCollection, reservationsCollection } from "../db.ts";
import { reservationIdSchema } from "../schemas.ts";
import { emailRetryDecision, type EmailOperation } from "../email-state.ts";
import { buildTicketEmail, ticketEmailKey } from "./ticket-email.ts";
import {
  allowedRecipient,
  resendConfig,
  sendResendRequest,
  ResendSendError,
  readResendEvent,
} from "./resend.ts";

export type ConfirmationResult =
  | "accepted"
  | "skipped"
  | "already-claimed"
  | "retryable"
  | "blocked"
  | "review-required"
  | "wait"
  | "failed";

// Domyślne wywołanie po zakupie nigdy nie ponawia istniejącej operacji.
// Operator ponawia wyłącznie pocztę: ten moduł nie zmienia punktów/płatności.
export async function sendTicketConfirmation(
  id: string,
  options: { retry?: boolean } = {},
): Promise<ConfirmationResult> {
  const config = resendConfig();
  if (!config || !reservationIdSchema.safeParse(id).success) return "skipped";
  const _id = new ObjectId(id);
  try {
    const reservations = reservationsCollection();
    const reservation = await reservations.findOne({ _id });
    if (!reservation || reservation.status !== "purchased") return "skipped";
    const previous = reservation.confirmationEmail;
    const now = new Date();
    let operation: EmailOperation;
    if (previous) {
      if (!options.retry) return "already-claimed";
      const decision = emailRetryDecision(previous, now);
      if (decision === "not-needed") return "already-claimed";
      if (decision === "wait") return "wait";
      if (decision === "review") return "review-required";
      operation = {
        ...previous,
        status: "sending",
        attempts: previous.attempts! + 1,
        attemptedAt: now,
        attemptToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 60_000),
      };
    } else {
      if (!allowedRecipient(reservation.email, config.live)) return "skipped";
      const event = await eventsCollection().findOne({
        _id: reservation.eventId,
      });
      if (!event) return "skipped";
      const email = buildTicketEmail(reservation, event);
      if (!email) return "skipped";
      operation = {
        status: "sending",
        attemptedAt: now,
        firstAttemptAt: now,
        attempts: 1,
        operationId: ticketEmailKey(reservation),
        attemptToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 60_000),
        deliveryStatus: "unknown",
        // Dokładnie ten sam nadawca, odbiorca i treść przy każdym retry.
        requestBody: JSON.stringify({ from: config.from, ...email }),
      };
    }
    const claimed = await reservations.updateOne(
      {
        _id,
        status: "purchased",
        code: reservation.code,
        ...(previous
          ? {
              "confirmationEmail.attemptToken": previous.attemptToken,
              "confirmationEmail.status": previous.status,
              "confirmationEmail.attempts": previous.attempts,
            }
          : {
              email: reservation.email,
              eventId: reservation.eventId,
              seatId: reservation.seatId,
              cardAmount: reservation.cardAmount,
              pointsUsed: reservation.pointsUsed,
              pointsEarned: reservation.pointsEarned,
              amount: reservation.amount,
              confirmationEmail: { $exists: false },
            }),
      },
      { $set: { confirmationEmail: operation } },
    );
    if (claimed.modifiedCount !== 1) return "already-claimed";
    const ownsAttempt = {
      _id,
      "confirmationEmail.attemptToken": operation.attemptToken,
      "confirmationEmail.status": "sending",
    };
    let providerId: string;
    try {
      providerId = await sendResendRequest(
        operation.requestBody!,
        operation.operationId!,
      );
    } catch (error) {
      const retryable = error instanceof ResendSendError && error.retryable;
      const status = retryable ? "retryable" : "blocked";
      await reservations.updateOne(ownsAttempt, {
        $set: {
          "confirmationEmail.status": status,
          "confirmationEmail.lastError":
            error instanceof ResendSendError
              ? error.kind
              : "configuration_or_payload",
          "confirmationEmail.leaseUntil": new Date(),
          "confirmationEmail.nextAttemptAt": new Date(
            Date.now() + 30_000 * 2 ** (operation.attempts! - 1),
          ),
        },
      });
      return status;
    }
    // Gdy zapis po 2xx zawiedzie, pozostaje lease i identyczny klucz/payload.
    await reservations.updateOne(ownsAttempt, {
      $set: {
        "confirmationEmail.status": "accepted",
        "confirmationEmail.providerId": providerId,
        "confirmationEmail.acceptedAt": new Date(),
        "confirmationEmail.deliveryStatus": "unknown",
      },
    });
    return "accepted";
  } catch {
    return "failed";
  }
}

// Autorytatywny odczyt po stronie serwera; bez publicznego endpointu bez podpisu.
export async function checkTicketDelivery(id: string) {
  if (!reservationIdSchema.safeParse(id).success) return "skipped";
  const _id = new ObjectId(id);
  try {
    const collection = reservationsCollection();
    const reservation = await collection.findOne({ _id });
    const state = reservation?.confirmationEmail;
    if (reservation?.status !== "purchased" || !state?.providerId)
      return "skipped";
    const event = await readResendEvent(state.providerId);
    const mapped: Record<
      string,
      NonNullable<EmailOperation["deliveryStatus"]>
    > = {
      delivered: "delivered",
      bounced: "bounced",
      delivery_delayed: "delayed",
      failed: "failed",
      complained: "complained",
      suppressed: "suppressed",
    };
    const status = mapped[event] ?? "unknown";
    // Opóźniony odczyt nie cofa doręczenia/odrzucenia do wcześniejszego stanu.
    const terminal = ["bounced", "failed", "complained", "suppressed"];
    const protectedStates = terminal.includes(status)
      ? []
      : status === "delivered"
        ? terminal
        : [...terminal, "delivered"];
    await collection.updateOne(
      {
        _id,
        "confirmationEmail.providerId": state.providerId,
        "confirmationEmail.deliveryStatus": { $nin: protectedStates },
      },
      {
        $set: {
          "confirmationEmail.deliveryStatus": status,
          "confirmationEmail.providerEvent": event,
          "confirmationEmail.deliveryCheckedAt": new Date(),
        },
      },
    );
    return event;
  } catch {
    return "check-failed";
  }
}
