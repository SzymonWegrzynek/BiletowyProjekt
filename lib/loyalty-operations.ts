import { randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";
import { loyaltyOperationsCollection } from "./db.ts";
import { adjustLoyaltyBalance } from "./voucherify.ts";

const DUPLICATE_KEY = 11000;

// Jak długo jedna próba „trzyma” operację. Dłużej niż timeout Voucherify,
// żeby nikt nie przejął operacji, która jeszcze czeka na odpowiedź.
export const LOYALTY_OPERATION_LEASE_MS = 30_000;

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
  // Inne wywołanie właśnie ją wykonuje — nie powtarzamy.
  | { status: "in_progress" };

// Wykonuje zmianę salda w Voucherify najwyżej raz dla danego id.
// Voucherify nie ma kluczy idempotencji, więc pilnuje tego baza:
// 1. operacja powstaje raz (unikalne _id, $setOnInsert),
// 2. wykonuje ją tylko ten, kto warunkowym zapisem ją „zajmie”
//    (pending → applying z lease), więc równoległe wywołania się nie dublują,
// 3. dopiero potwierdzenie z Voucherify zmienia status na done.
// Dane operacji (karta, punkty) zawsze z bazy — ponowienie nie może ich zmienić.
export async function applyLoyaltyOperation(
  input: LoyaltyOperationInput,
): Promise<LoyaltyOperationResult> {
  const operations = loyaltyOperationsCollection();
  const now = new Date();

  // Skrót: najczęstszy przypadek (bonus dawno przyznany) bez zapisów.
  const known = await operations.findOne(
    { _id: input.id },
    { projection: { status: 1 } },
  );
  if (known?.status === "done") return { status: "done", appliedNow: false };

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
  const claimed = await operations.findOneAndUpdate(
    {
      _id: input.id,
      $or: [
        { status: "pending" },
        // Poprzednia próba utknęła (np. proces padł) — lease minął.
        { status: "applying", leaseUntil: { $lte: now } },
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
    { returnDocument: "after" },
  );

  if (!claimed) {
    const current = await operations.findOne(
      { _id: input.id },
      { projection: { status: 1 } },
    );
    if (current?.status === "done") {
      return { status: "done", appliedNow: false };
    }
    return { status: "in_progress" };
  }

  let balanceAfter: number | undefined;
  try {
    ({ balance: balanceAfter } = await adjustLoyaltyBalance(
      claimed.cardCode,
      claimed.points,
      { sourceId: claimed._id, reason: claimed.reason },
    ));
  } catch (error) {
    // Zwalniamy operację z powrotem do pending, żeby dało się ją dokończyć.
    await operations.updateOne(
      { _id: claimed._id, leaseToken },
      {
        $set: {
          status: "pending",
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
    { _id: claimed._id, leaseToken },
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
  return { status: "done", appliedNow: true, balanceAfter };
}
