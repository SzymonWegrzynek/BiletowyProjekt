import { randomUUID } from "node:crypto";
import {
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
} from "./db.ts";
import { ensureLoyaltyCard } from "./loyalty-account.ts";
import {
  applyLoyaltyOperation,
  getLoyaltyOperationStatus,
} from "./loyalty-operations.ts";
import { LoyaltyUnavailableError, getLoyaltyCard } from "./voucherify.ts";

// Jak długo jedno wydawanie „trzyma” konto klienta.
const SPEND_LOCK_MS = 20_000;

// Na karcie jest mniej punktów, niż klient chce wydać → 4xx dla klienta.
export class InsufficientPointsError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super(`Za mało punktów: dostępne ${available}, potrzebne ${requested}`);
  }
}

// Voucherify odrzucił potrącenie (np. sam pilnuje salda) — bez ponowień.
export class SpendRejectedError extends Error {}

// Id potrącenia: jedna rezerwacja może mieć kilka prób płatności (przerwana
// płatność, nowe „Zapłać”), każda z własnym attempt (np. id sesji Checkout).
// Ten sam attempt drugi raz = ta sama operacja = jedno potrącenie.
export const spendOperationId = (reservationId: string, attempt: string) =>
  `redeem:${reservationId}:${attempt}`;
export const returnOperationId = (reservationId: string, attempt: string) =>
  `return:${reservationId}:${attempt}`;

function busy(what: string): LoyaltyUnavailableError {
  return new LoyaltyUnavailableError(`${what} w toku`, "not_applied", 1);
}

async function withSpendLock<T>(email: string, run: () => Promise<T>) {
  const accounts = loyaltyAccountsCollection();
  const now = new Date();
  const token = randomUUID();
  const locked = await accounts.findOneAndUpdate(
    {
      _id: email,
      $or: [
        { spendLockUntil: { $exists: false } },
        { spendLockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        spendLockToken: token,
        spendLockUntil: new Date(now.getTime() + SPEND_LOCK_MS),
      },
    },
    { projection: { _id: 1 } },
  );
  if (!locked) throw busy(`Wydawanie punktów ${email}`);
  try {
    return await run();
  } finally {
    await accounts.updateOne(
      { _id: email, spendLockToken: token },
      { $unset: { spendLockToken: "", spendLockUntil: "" } },
    );
  }
}

// Wydanie punktów na rezerwację (checkout z punktami). Gwarancje:
// - ten sam (reservationId, attempt) potrąca najwyżej raz — także równolegle,
// - dwie rezerwacje tego samego klienta nie wydadzą razem więcej, niż ma:
//   wydawanie jest po kolei (blokada na koncie) i każde sprawdza saldo
//   z Voucherify tuż przed potrąceniem,
// - saldo może zmienić się też poza aplikacją (inny kanał), więc sama
//   blokada nie wystarcza: gdy po potrąceniu saldo wyszło ujemne, punkty
//   wracają (operacja return:…) i klient dostaje odmowę.
// email musi być znormalizowany (loyaltyEmailSchema).
export async function spendLoyaltyPoints({
  email,
  reservationId,
  attempt,
  points,
}: {
  email: string;
  reservationId: string;
  attempt: string;
  points: number;
}): Promise<{ balanceAfter?: number }> {
  if (!Number.isSafeInteger(points) || points <= 0) {
    throw new RangeError("Liczba punktów do wydania musi być dodatnia");
  }
  const id = spendOperationId(reservationId, attempt);
  const cardCode = await ensureLoyaltyCard(email);

  return withSpendLock(email, async () => {
    // Saldo sprawdzamy tylko przed pierwszym potrąceniem. Gdy operacja już
    // istnieje, rozstrzyga ją applyLoyaltyOperation (bez drugiego potrącenia).
    if ((await getLoyaltyOperationStatus(id)) === undefined) {
      const { balance } = await getLoyaltyCard(cardCode);
      if (balance < points) throw new InsufficientPointsError(balance, points);
    }

    const result = await applyLoyaltyOperation({
      id,
      email,
      cardCode,
      points: -points,
      reason: `Płatność punktami (rezerwacja ${reservationId})`,
    });
    if (result.status === "in_progress") throw busy(`Potrącenie ${id}`);
    if (result.status === "failed") {
      throw new SpendRejectedError(
        result.error ?? `Potrącenie ${id} odrzucone`,
      );
    }

    if (
      result.appliedNow &&
      result.balanceAfter !== undefined &&
      result.balanceAfter < 0
    ) {
      // Klient wydał w międzyczasie punkty gdzie indziej — cofamy potrącenie.
      await returnSpentPoints({ reservationId, attempt });
      throw new InsufficientPointsError(result.balanceAfter + points, points);
    }
    return { balanceAfter: result.balanceAfter };
  });
}

export type ReturnResult =
  | "returned" // potrącenie było — punkty wróciły
  | "cancelled" // potrącenie nie zdążyło się wykonać i już się nie wykona
  | "nothing"; // nie było czego zwracać

// Zwrot punktów z próby płatności, która się nie udała (przerwana płatność,
// wygasła sesja, błąd Stripe po potrąceniu). Bezpieczne do ponawiania:
// zwrot to operacja return:<reservationId>:<attempt>, wykonywana raz, i tylko
// wtedy, gdy potrącenie na pewno się wykonało.
export async function returnSpentPoints({
  reservationId,
  attempt,
}: {
  reservationId: string;
  attempt: string;
}): Promise<ReturnResult> {
  const operations = loyaltyOperationsCollection();
  const id = spendOperationId(reservationId, attempt);

  // Potrącenie czeka i nikt go nie wykonuje — anulujemy je warunkowym
  // zapisem, więc nie wykona się później (wyścig z applyLoyaltyOperation
  // rozstrzyga baza: wygrywa jeden zapis).
  const cancelled = await operations.updateOne(
    { _id: id, status: "pending" },
    {
      $set: {
        status: "failed",
        lastError: "Anulowane — płatność nieukończona",
        updatedAt: new Date(),
      },
    },
  );
  if (cancelled.modifiedCount === 1) return "cancelled";

  const spend = await operations.findOne({ _id: id });
  if (!spend || spend.status === "failed") return "nothing";
  if (spend.status !== "done") {
    // applying / unknown: nie wiadomo jeszcze, czy punkty zeszły z karty.
    throw busy(`Rozstrzyganie potrącenia ${id}`);
  }

  const result = await applyLoyaltyOperation({
    id: returnOperationId(reservationId, attempt),
    email: spend.email,
    cardCode: spend.cardCode,
    points: -spend.points,
    reason: `Zwrot punktów — płatność nieukończona (rezerwacja ${reservationId})`,
  });
  if (result.status === "in_progress") throw busy(`Zwrot ${id}`);
  if (result.status === "failed") {
    throw new SpendRejectedError(result.error ?? `Zwrot ${id} odrzucony`);
  }
  return "returned";
}
