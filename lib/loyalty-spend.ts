import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import {
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
  reservationsCollection,
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
  readonly available: number;
  readonly requested: number;

  constructor(available: number, requested: number) {
    super(`Za mało punktów: dostępne ${available}, potrzebne ${requested}`);
    this.available = available;
    this.requested = requested;
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
  // Znacznik na potrąceniu: zwrot zrobiony, nie trzeba go więcej szukać.
  await operations.updateOne(
    { _id: id, returnedAt: { $exists: false } },
    { $set: { returnedAt: new Date() } },
  );
  return "returned";
}

// --- Punkty z rezerwacji, która nie zostanie opłacona -----------------------
//
// Vercel Cron na darmowym planie działa raz dziennie, a punkty mają wrócić
// najpóźniej 15 s po wygaśnięciu rezerwacji. Dlatego zwrot robi ten, kto
// pierwszy zapyta: GET /api/loyalty klienta, webhook spóźnionej płatności
// albo skrypt pnpm loyalty:pending --finish. Każde z nich jest bezpieczne
// do powtarzania (zwrot to operacja return:… wykonywana raz).

const SPEND_PREFIX = "redeem:";
const RESERVATION_ID = /^[0-9a-f]{24}$/i;

export function parseSpendOperationId(
  id: string,
): { reservationId: string; attempt: string } | undefined {
  if (!id.startsWith(SPEND_PREFIX)) return undefined;
  const rest = id.slice(SPEND_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return undefined;
  return {
    reservationId: rest.slice(0, separator),
    attempt: rest.slice(separator + 1),
  };
}

// Potrącenia, które mogą wymagać zwrotu: wykonane (done) i jeszcze nie
// zwrócone albo czekające (pending — wtedy zwrot je anuluje).
// applying / unknown pomijamy: nie wiadomo, czy punkty zeszły z karty —
// rozstrzyga je ścieżka płatności, a lista jest w pnpm loyalty:pending.
export async function findUnreturnedSpends({
  email,
  reservationId,
  limit = 20,
}: {
  email?: string | RegExp;
  reservationId?: string;
  limit?: number;
}): Promise<string[]> {
  const prefix = reservationId
    ? `^${SPEND_PREFIX}${reservationId}:`
    : `^${SPEND_PREFIX}`;
  const spends = await loyaltyOperationsCollection()
    .find(
      {
        _id: { $regex: prefix },
        status: { $in: ["done", "pending"] },
        returnedAt: { $exists: false },
        keptAt: { $exists: false },
        ...(email === undefined ? {} : { email }),
      },
      { projection: { _id: 1 } },
    )
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
  return spends.map((spend) => spend._id);
}

// Czy punkty wydane na rezerwację wolno już oddać:
// - rezerwacji nie ma (wygasła, a miejsce przejął ktoś inny) → tak,
// - wygasła "held" → tak, ale najpierw warunkowy zapis pointsReleasedAt.
//   Webhook zamienia w bilet tylko "held" BEZ tego znacznika, więc wyścig
//   „zwrot punktów” vs „spóźniona płatność” rozstrzyga baza: albo bilet
//   (i punkty zostają wydane), albo zwrot punktów i zwrot pieniędzy,
// - "purchased" → nie, punkty zostają wydane ("paid"),
// - ważna "held" → jeszcze nie ("valid").
export type SpendReleaseDecision = "release" | "paid" | "valid";

export async function claimSpendRelease(
  reservationId: string,
  now = new Date(),
): Promise<SpendReleaseDecision> {
  // Id spoza naszych rezerwacji — nie zgadujemy, nic nie oddajemy.
  if (!RESERVATION_ID.test(reservationId)) return "valid";
  const _id = new ObjectId(reservationId);
  const reservations = reservationsCollection();

  const marked = await reservations.updateOne(
    {
      _id,
      status: "held",
      expiresAt: { $lte: now },
      pointsReleasedAt: { $exists: false },
    },
    { $set: { pointsReleasedAt: now } },
  );
  if (marked.modifiedCount === 1) return "release";

  // Zapis nic nie zmienił — odczyt tylko po to, żeby wybrać gałąź.
  // Znacznik ani "purchased" nie znikają, więc tu nie ma wyścigu.
  const current = await reservations.findOne(
    { _id },
    { projection: { status: 1, pointsReleasedAt: 1 } },
  );
  if (!current) return "release";
  if (current.status === "purchased") return "paid";
  return current.pointsReleasedAt === undefined ? "valid" : "release";
}

// Zwrot punktów z jednego potrącenia, jeśli jego rezerwacja nie zostanie
// opłacona. Wynik "kept" = rezerwacja wciąż ważna albo opłacona.
export async function releaseSpendIfUnused(
  spendId: string,
  now = new Date(),
): Promise<ReturnResult | "kept"> {
  const parsed = parseSpendOperationId(spendId);
  if (!parsed) return "nothing";
  const decision = await claimSpendRelease(parsed.reservationId, now);
  if (decision === "valid") return "kept";
  if (decision === "paid") {
    const operations = loyaltyOperationsCollection();
    // Potrącenie, które się nie wykonało, a rezerwacja jest już opłacona
    // (inną próbą płatności) — nie może wykonać się później.
    const cancelled = await operations.updateOne(
      { _id: spendId, status: "pending" },
      {
        $set: {
          status: "failed",
          lastError: "Anulowane — rezerwacja opłacona inną próbą płatności",
          updatedAt: new Date(),
        },
      },
    );
    if (cancelled.modifiedCount === 1) return "cancelled";
    // Wykonane potrącenie opłaconego biletu zostaje; nie szukamy go więcej.
    // (Zwrot punktów z zastąpionej próby płatności robi ścieżka checkoutu
    // przez returnSpentPoints — znacznik mu nie przeszkadza.)
    await operations.updateOne(
      { _id: spendId, status: "done" },
      { $set: { keptAt: new Date() } },
    );
    return "kept";
  }
  return returnSpentPoints(parsed);
}

// Wszystkie potrącenia jednej rezerwacji (np. z webhooka, który właśnie
// zwrócił pieniądze za spóźnioną płatność).
export async function releaseSpendsForReservation(
  reservationId: string,
): Promise<void> {
  for (const spendId of await findUnreturnedSpends({ reservationId })) {
    await releaseSpendIfUnused(spendId);
  }
}
