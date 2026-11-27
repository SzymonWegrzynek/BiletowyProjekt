import { randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";
import { loyaltyOperationsCollection } from "./db.ts";
import type { LoyaltyOperation } from "./schemas.ts";
import {
  LoyaltyUnavailableError,
  VoucherifyRequestError,
  adjustLoyaltyBalance,
  hasLoyaltyTransaction,
} from "./voucherify.ts";

const DUPLICATE_KEY = 11000;

// Jak długo jedna próba „trzyma” operację. Dłużej niż timeout Voucherify,
// żeby nikt nie przejął operacji, która jeszcze czeka na odpowiedź.
export const LOYALTY_OPERATION_LEASE_MS = 30_000;

// Po ilu ms od niepewnej próby wolno ją rozstrzygać. Zmiana salda w
// Voucherify jest asynchroniczna — transakcja może pojawić się na liście
// z opóźnieniem, a wcześniejsze „nie ma jej” prowadziłoby do podwójnej zmiany.
export const LOYALTY_RECONCILE_DELAY_MS = 60_000;

export type LoyaltyOperationInput = {
  id: string; // stabilny identyfikator, np. "bonus:<email>"
  email: string;
  cardCode: string;
  points: number;
  reason: string;
};

export type LoyaltyOperationResult =
  // Zmiana salda jest w Voucherify. appliedNow = wykonało ją to wywołanie
  // (wtedy balanceAfter to saldo zaraz po zmianie, jeśli Voucherify je podał).
  | { status: "done"; appliedNow: boolean; balanceAfter?: number }
  // Inne wywołanie właśnie ją wykonuje albo czeka na rozstrzygnięcie
  // niepewnej próby — nie powtarzamy w ciemno.
  | { status: "in_progress" }
  // Voucherify ją odrzucił (np. za mało punktów) — nie ponawiamy.
  | { status: "failed"; error?: string };

// Status po nieudanej próbie: czy wolno ją po prostu ponowić.
function statusAfterError(
  error: unknown,
  reconciling: boolean,
): LoyaltyOperation["status"] {
  // Wynik poprzedniej próby był nieznany i nadal jest.
  if (reconciling) return "unknown";
  if (error instanceof VoucherifyRequestError) return "failed";
  if (
    error instanceof LoyaltyUnavailableError &&
    error.outcome === "not_applied"
  ) {
    return "pending";
  }
  // Timeout, 5xx, nieoczekiwany błąd: zmiana mogła się wykonać.
  return "unknown";
}

// Wykonuje zmianę salda w Voucherify najwyżej raz dla danego id.
// Voucherify nie ma kluczy idempotencji, więc pilnuje tego baza:
// 1. operacja powstaje raz (unikalne _id, $setOnInsert),
// 2. wykonuje ją tylko ten, kto warunkowym zapisem ją „zajmie”
//    (→ applying z lease), więc równoległe wywołania się nie dublują,
// 3. niepewna próba (timeout, 5xx, proces padł) dostaje status unknown;
//    przed kolejną sprawdzamy w historii karty, czy transakcja z naszym
//    source_id już jest — zamiast powtarzać zmianę salda w ciemno,
// 4. dopiero potwierdzenie z Voucherify zmienia status na done.
// Dane operacji (karta, punkty) zawsze z bazy — ponowienie nie może ich zmienić.
export async function applyLoyaltyOperation(
  input: LoyaltyOperationInput,
): Promise<LoyaltyOperationResult> {
  const operations = loyaltyOperationsCollection();
  const now = new Date();

  // Skrót: najczęstszy przypadek (bonus dawno przyznany) bez zapisów.
  const known = await operations.findOne(
    { _id: input.id },
    { projection: { status: 1, lastError: 1 } },
  );
  if (known?.status === "done") return { status: "done", appliedNow: false };
  if (known?.status === "failed") {
    return { status: "failed", error: known.lastError };
  }

  if (!known) {
    try {
      await operations.updateOne(
        { _id: input.id },
        {
          $setOnInsert: {
            email: input.email,
            cardCode: input.cardCode,
            points: input.points,
            reason: input.reason,
            status: "pending",
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // Dwa równoległe upserty tego samego _id — jeden przegrywa E11000,
      // ale operacja i tak istnieje. Idziemy dalej.
      if (!(
        error instanceof MongoServerError && error.code === DUPLICATE_KEY
      )) {
        throw error;
      }
    }
  }

  const leaseToken = randomUUID();
  const before = await operations.findOneAndUpdate(
    {
      _id: input.id,
      $or: [
        { status: "pending" },
        // Poprzednia próba utknęła (np. proces padł w trakcie) — lease minął.
        { status: "applying", leaseUntil: { $lte: now } },
        // Niepewna próba, odczekana tyle, że jej transakcja byłaby widoczna.
        {
          status: "unknown",
          updatedAt: {
            $lte: new Date(now.getTime() - LOYALTY_RECONCILE_DELAY_MS),
          },
        },
      ],
    },
    {
      $set: {
        status: "applying",
        leaseToken,
        leaseUntil: new Date(now.getTime() + LOYALTY_OPERATION_LEASE_MS),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    // "before": potrzebny poprzedni status — czy wynik ostatniej próby był znany.
    { returnDocument: "before" },
  );

  if (!before) {
    const current = await operations.findOne(
      { _id: input.id },
      { projection: { status: 1, lastError: 1 } },
    );
    if (current?.status === "done") {
      return { status: "done", appliedNow: false };
    }
    if (current?.status === "failed") {
      return { status: "failed", error: current.lastError };
    }
    return { status: "in_progress" };
  }

  const reconciling = before.status !== "pending";
  let balanceAfter: number | undefined;
  let appliedNow = true;
  try {
    if (
      reconciling &&
      (await hasLoyaltyTransaction(before.cardCode, before._id))
    ) {
      // Poprzednia próba jednak się wykonała — nie powtarzamy.
      appliedNow = false;
    } else {
      ({ balance: balanceAfter } = await adjustLoyaltyBalance(
        before.cardCode,
        before.points,
        { sourceId: before._id, reason: before.reason },
      ));
    }
  } catch (error) {
    await operations.updateOne(
      { _id: before._id, leaseToken },
      {
        $set: {
          status: statusAfterError(error, reconciling),
          lastError: String(error),
          updatedAt: new Date(),
        },
        $unset: { leaseToken: "", leaseUntil: "" },
      },
    );
    throw error;
  }

  const doneAt = new Date();
  await operations.updateOne(
    { _id: before._id, leaseToken },
    {
      $set: {
        status: "done",
        doneAt,
        updatedAt: doneAt,
        ...(balanceAfter === undefined ? {} : { balanceAfter }),
      },
      $unset: { leaseToken: "", leaseUntil: "", lastError: "" },
    },
  );
  return { status: "done", appliedNow, balanceAfter };
}

// Stan operacji (np. do czekania na równoległe wywołanie).
export async function getLoyaltyOperationStatus(
  id: string,
): Promise<LoyaltyOperation["status"] | undefined> {
  const operation = await loyaltyOperationsCollection().findOne(
    { _id: id },
    { projection: { status: 1 } },
  );
  return operation?.status;
}
