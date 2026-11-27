import { randomUUID } from "node:crypto";
import { checkoutAttemptsCollection } from "./db.ts";
import {
  InsufficientPointsError,
  SpendRejectedError,
  returnSpentPoints,
  spendLoyaltyPoints,
} from "./loyalty-spend.ts";
import type { CheckoutAttempt } from "./schemas.ts";
import { CHECKOUT_SESSION_TTL_MS } from "./stripe.ts";
import { LoyaltyUnavailableError } from "./voucherify.ts";

// Płatność częściowo punktami (Etap III). Voucherify i Stripe nie mają wspólnej
// transakcji, więc każdą próbę zapisujemy w checkoutAttempts i prowadzimy
// warunkowymi zapisami przez stany:
//
//   spending ──▶ open ──▶ paid               (webhook: sesja opłacona → bilet)
//      │          │        └─▶ returning     (płatność wróciła do klienta)
//      │          └──────────▶ returning     (sesja wygasła / zastąpiona)
//      ├─▶ returning                          (Stripe nie utworzył sesji)
//      └─▶ failed                             (potrącenie odrzucone — nic nie zeszło)
//   returning ──▶ returned                    (punkty na pewno wróciły)
//
// Zasada: punkty wracają tylko z próby, której sesji na pewno nie da się
// opłacić (Stripe jej nie utworzył, wygasła albo płatność została zwrócona).
// Przejścia open → paid i open → returning wykluczają się w bazie, więc
// spóźniony webhook nie dostanie biletu za zwrócone punkty.

// 1 punkt = 1 grosz; punktami najwyżej połowa ceny.
export function maxPointsFor(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) return 0;
  return Math.floor(amount / 2);
}

// Próba „spending” starsza niż to mogła mieć sesję Stripe, której id nie
// zdążyliśmy zapisać (proces padł). Sesja żyje najwyżej CHECKOUT_SESSION_TTL_MS,
// więc po tym czasie na pewno nie da się jej już opłacić.
export const STALE_SPENDING_MS = CHECKOUT_SESSION_TTL_MS + 5 * 60_000;

export type SpendOutcome =
  | { ok: true; attemptId: string }
  | { ok: false; reason: "insufficient"; available?: number }
  | { ok: false; reason: "unavailable"; retryAfterSeconds?: number };

// Zakłada próbę i potrąca punkty z karty klienta. Próba powstaje PRZED
// potrąceniem, więc nawet po awarii procesu wiadomo, co trzeba oddać.
export async function spendPointsForCheckout({
  reservationId,
  email,
  points,
  amount,
}: {
  reservationId: string;
  email: string;
  points: number;
  amount: number;
}): Promise<SpendOutcome> {
  const attempts = checkoutAttemptsCollection();
  const attemptId = randomUUID();
  const now = new Date();
  await attempts.insertOne({
    _id: attemptId,
    reservationId,
    email,
    points,
    cardAmount: amount - points,
    status: "spending",
    createdAt: now,
    updatedAt: now,
  });

  try {
    await spendLoyaltyPoints({
      email,
      reservationId,
      attempt: attemptId,
      points,
    });
    return { ok: true, attemptId };
  } catch (error) {
    if (
      error instanceof InsufficientPointsError ||
      error instanceof SpendRejectedError
    ) {
      // Potrącenie się nie wykonało (albo zostało już cofnięte przez
      // spendLoyaltyPoints) — nic do oddania.
      await attempts.updateOne(
        { _id: attemptId, status: "spending" },
        {
          $set: {
            status: "failed",
            lastError: String(error),
            updatedAt: new Date(),
          },
        },
      );
      return {
        ok: false,
        reason: "insufficient",
        available:
          error instanceof InsufficientPointsError
            ? error.available
            : undefined,
      };
    }
    if (error instanceof LoyaltyUnavailableError) {
      // Wynik potrącenia może być nieznany (timeout). Nie zgadujemy —
      // próba idzie do zwrotu, który rozstrzyga rejestr operacji.
      await compensateAttempt(attemptId, "loyalty_unavailable");
      return {
        ok: false,
        reason: "unavailable",
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    // Nieoczekiwany błąd (np. baza) — próba zostaje „spending” i dokończy ją
    // pnpm loyalty:pending --finish po STALE_SPENDING_MS.
    throw error;
  }
}

// Sesja Stripe utworzona — próbę da się teraz opłacić.
export async function openAttempt(
  attemptId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await checkoutAttemptsCollection().updateOne(
    { _id: attemptId, status: "spending" },
    { $set: { status: "open", sessionId, updatedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

export type ClaimResult =
  | { status: "paid"; attempt: CheckoutAttempt }
  | { status: "returned" } // punkty już oddane — sesji nie wolno zamienić na bilet
  | { status: "missing" };

// Webhook: opłacona sesja „zajmuje” swoją próbę (open → paid). Wyklucza się
// z compensateAttempt warunkowym zapisem — wygrywa dokładnie jedno.
// Ponowiony webhook tej samej sesji dostaje ten sam wynik.
export async function claimAttemptForPayment(
  attemptId: string,
  sessionId: string,
): Promise<ClaimResult> {
  const attempts = checkoutAttemptsCollection();
  const claimed = await attempts.findOneAndUpdate(
    {
      _id: attemptId,
      status: { $in: ["open", "spending"] },
      // "spending" bez sessionId: proces padł po utworzeniu sesji.
      $or: [{ sessionId }, { sessionId: { $exists: false } }],
    },
    { $set: { status: "paid", sessionId, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (claimed) return { status: "paid", attempt: claimed };

  const current = await attempts.findOne({ _id: attemptId });
  if (!current) return { status: "missing" };
  if (current.status === "paid" && current.sessionId === sessionId) {
    return { status: "paid", attempt: current };
  }
  if (current.status === "returning" || current.status === "returned") {
    return { status: "returned" };
  }
  // Inna sesja albo "failed" — ta sesja nie należy do próby.
  return { status: "missing" };
}

export type CompensationResult =
  | "returned" // punkty wróciły (albo potrącenie się nie wykonało)
  | "pending" // Voucherify chwilowo niedostępny — dokończy ponowienie / skrypt
  | "skipped"; // próba opłacona albo nie wymaga zwrotu

// Oddaje punkty z próby, której sesji nie da się już opłacić. Bezpieczne do
// ponawiania: zwrot to operacja return:<reservationId>:<attemptId> (raz).
// allowPaid — tylko gdy płatność tej próby wróciła do klienta (zwrot Stripe).
export async function compensateAttempt(
  attemptId: string,
  reason: string,
  { allowPaid = false }: { allowPaid?: boolean } = {},
): Promise<CompensationResult> {
  const attempts = checkoutAttemptsCollection();
  const from: CheckoutAttempt["status"][] = ["spending", "open", "returning"];
  if (allowPaid) from.push("paid");

  const attempt = await attempts.findOneAndUpdate(
    { _id: attemptId, status: { $in: from } },
    { $set: { status: "returning", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!attempt) {
    const current = await attempts.findOne(
      { _id: attemptId },
      { projection: { status: 1 } },
    );
    return current?.status === "returned" ? "returned" : "skipped";
  }
  // Pierwszy powód zostaje — ponowienie nie nadpisuje diagnostyki.
  if (!attempt.returnReason) {
    await attempts.updateOne(
      { _id: attemptId, returnReason: { $exists: false } },
      { $set: { returnReason: reason } },
    );
  }

  try {
    await returnSpentPoints({
      reservationId: attempt.reservationId,
      attempt: attemptId,
    });
  } catch (error) {
    if (
      error instanceof LoyaltyUnavailableError ||
      error instanceof SpendRejectedError
    ) {
      console.error(`Zwrot punktów próby ${attemptId} czeka`, error);
      await attempts.updateOne(
        { _id: attemptId, status: "returning" },
        { $set: { lastError: String(error), updatedAt: new Date() } },
      );
      return "pending";
    }
    throw error;
  }

  await attempts.updateOne(
    { _id: attemptId, status: "returning" },
    {
      $set: { status: "returned", updatedAt: new Date() },
      $unset: { lastError: "" },
    },
  );
  return "returned";
}

// Próby do dokończenia przez pnpm loyalty:pending:
// - returning — zwrot zaczęty, Voucherify nie odpowiedział,
// - spending starsze niż STALE_SPENDING_MS — proces padł w trakcie checkoutu,
// - open starsze niż czas życia sesji — sesja wygasła albo czeka na webhook;
//   rozstrzyga stan sesji w Stripe (patrz loyalty-recovery).
export async function listUnfinishedAttempts({
  limit = 100,
  email,
  now = new Date(),
}: {
  limit?: number;
  email?: string | RegExp;
  now?: Date;
} = {}): Promise<CheckoutAttempt[]> {
  const byEmail = email === undefined ? {} : { email };
  const staleSpending = new Date(now.getTime() - STALE_SPENDING_MS);
  const staleOpen = new Date(now.getTime() - CHECKOUT_SESSION_TTL_MS);
  return checkoutAttemptsCollection()
    .find({
      ...byEmail,
      $or: [
        { status: "returning" },
        { status: "spending", updatedAt: { $lte: staleSpending } },
        { status: "open", updatedAt: { $lte: staleOpen } },
      ],
    })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
}
