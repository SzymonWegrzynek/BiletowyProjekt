import { setTimeout as sleep } from "node:timers/promises";
import { MongoServerError } from "mongodb";
import { loyaltyAccountsCollection } from "./db.ts";
import {
  applyLoyaltyOperation,
  getLoyaltyOperationStatus,
} from "./loyalty-operations.ts";
import {
  LoyaltyUnavailableError,
  getLoyaltyCard,
  joinLoyaltyProgram,
} from "./voucherify.ts";

const DUPLICATE_KEY = 11000;

// Nowy klient dostaje raz 1000 punktów (1 punkt = 1 grosz).
export const LOYALTY_WELCOME_BONUS = 1000;

export const welcomeBonusOperationId = (email: string) => `bonus:${email}`;

// Jak długo odczyt salda może pochodzić z kopii w bazie zamiast z Voucherify.
// Zmiany robione przez aplikację (bonus, nagroda, potrącenie, zwrot) od razu
// unieważniają kopię, więc opóźnienie dotyczy tylko zmian w innych kanałach.
// 0 = zawsze pytaj Voucherify.
export function getBalanceCacheMs(): number {
  const seconds = Number(process.env.LOYALTY_BALANCE_CACHE_SECONDS ?? 15);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      "LOYALTY_BALANCE_CACHE_SECONDS musi być nieujemną liczbą sekund",
    );
  }
  return seconds * 1000;
}

// Jak długo jedno wywołanie „trzyma” dołączanie klienta do programu.
const JOIN_LEASE_MS = 15_000;

// Równoległy odczyt czeka chwilę na wynik cudzego dołączenia / bonusu,
// zamiast od razu odpowiadać 503. Dłużej nie — to request HTTP.
const WAIT_STEP_MS = 200;
const WAIT_STEPS = 15;

function busy(what: string): LoyaltyUnavailableError {
  return new LoyaltyUnavailableError(`${what} w toku`, "not_applied", 1);
}

async function readCardCode(email: string): Promise<string | undefined> {
  const account = await loyaltyAccountsCollection().findOne(
    { _id: email },
    { projection: { cardCode: 1 } },
  );
  return account?.cardCode;
}

// Kod karty lojalnościowej klienta. Pierwszy odczyt dołącza klienta do
// kampanii w Voucherify i zapamiętuje kartę; kolejne biorą ją z bazy.
// Równoległe pierwsze odczyty: do Voucherify idzie tylko ten, kto warunkowym
// zapisem zajmie dołączanie (lease) — reszta czeka na jego wynik.
// email musi być już znormalizowany (loyaltyEmailSchema).
export async function ensureLoyaltyCard(email: string): Promise<string> {
  const accounts = loyaltyAccountsCollection();
  const existing = await readCardCode(email);
  if (existing) return existing;

  const now = new Date();
  try {
    await accounts.updateOne(
      { _id: email },
      { $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  } catch (error) {
    // Równoległy upsert tego samego e-maila — dokument i tak już jest.
    if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) {
      throw error;
    }
  }

  const leaseUntil = new Date(now.getTime() + JOIN_LEASE_MS);
  const claimed = await accounts.findOneAndUpdate(
    {
      _id: email,
      cardCode: { $exists: false },
      $or: [
        { joinLeaseUntil: { $exists: false } },
        { joinLeaseUntil: { $lte: now } },
      ],
    },
    { $set: { joinLeaseUntil: leaseUntil } },
    { returnDocument: "after", projection: { _id: 1 } },
  );

  if (!claimed) {
    // Ktoś inny właśnie dołącza tego klienta (albo już dołączył).
    for (let step = 0; step < WAIT_STEPS; step++) {
      const cardCode = await readCardCode(email);
      if (cardCode) return cardCode;
      await sleep(WAIT_STEP_MS);
    }
    throw busy(`Zakładanie konta punktowego ${email}`);
  }

  let cardCode: string;
  try {
    // Voucherify i tak daje klientowi jedną kartę w kampanii (join_once),
    // więc ponowienie po awarii nie tworzy drugiej.
    ({ cardCode } = await joinLoyaltyProgram(email));
  } catch (error) {
    await accounts.updateOne(
      { _id: email, joinLeaseUntil: leaseUntil },
      { $unset: { joinLeaseUntil: "" } },
    );
    throw error;
  }

  await accounts.updateOne(
    { _id: email, cardCode: { $exists: false } },
    {
      $set: { cardCode, joinedAt: new Date() },
      $unset: { joinLeaseUntil: "" },
    },
  );
  const saved = await readCardCode(email);
  if (!saved) throw new Error(`Konto punktowe ${email} bez karty po zapisie`);
  return saved;
}

// Saldo z Voucherify albo z kopii młodszej niż getBalanceCacheMs().
// Kopia jest tylko oszczędnością zapytań — źródłem prawdy zostaje Voucherify
// (płatność punktami zawsze sprawdza saldo w Voucherify, nie w kopii).
async function readBalance(email: string, cardCode: string): Promise<number> {
  const accounts = loyaltyAccountsCollection();
  const cacheMs = getBalanceCacheMs();
  const account = await accounts.findOne(
    { _id: email },
    { projection: { balance: 1, balanceAt: 1, balanceVersion: 1 } },
  );
  if (
    cacheMs > 0 &&
    account?.balance !== undefined &&
    account.balanceAt &&
    Date.now() - account.balanceAt.getTime() < cacheMs
  ) {
    return account.balance;
  }

  const { balance } = await getLoyaltyCard(cardCode);
  if (cacheMs > 0) {
    // Warunkowy zapis: gdy w trakcie odczytu aplikacja zmieniła saldo
    // (wersja wzrosła), odczytane saldo może być sprzed zmiany — nie zapisujemy.
    const version = account?.balanceVersion;
    await accounts.updateOne(
      {
        _id: email,
        // Konto bez żadnej zmiany salda nie ma jeszcze pola wersji.
        balanceVersion: version === undefined ? { $exists: false } : version,
      },
      { $set: { balance, balanceAt: new Date() } },
    );
  }
  return balance;
}

// Aktualne saldo klienta. Nowemu klientowi najpierw przyznaje bonus — raz,
// bo bonus to operacja o stałym id. Saldo z Voucherify (lub jego świeżej
// kopii), nigdy wyliczane z naszej bazy.
export async function getLoyaltyBalance(email: string): Promise<number> {
  const cardCode = await ensureLoyaltyCard(email);
  const bonusId = welcomeBonusOperationId(email);

  const bonus = await applyLoyaltyOperation({
    id: bonusId,
    email,
    cardCode,
    points: LOYALTY_WELCOME_BONUS,
    reason: "Bonus powitalny",
  });
  if (bonus.status === "failed") {
    throw new LoyaltyUnavailableError(
      `Bonus powitalny dla ${email} odrzucony: ${bonus.error ?? ""}`,
      "not_applied",
    );
  }
  if (bonus.status === "in_progress") {
    // Bonus nalicza równoległe wywołanie albo czeka na rozstrzygnięcie.
    // Saldo bez niego byłoby nieprawdziwe — czekamy chwilę, potem 503.
    let done = false;
    for (let step = 0; step < WAIT_STEPS && !done; step++) {
      await sleep(WAIT_STEP_MS);
      done = (await getLoyaltyOperationStatus(bonusId)) === "done";
    }
    if (!done) throw busy(`Bonus powitalny dla ${email}`);
  }
  // Saldo zaraz po przyznaniu bonusu podaje sam Voucherify — oszczędza
  // zapytanie i nie zależy od tego, kiedy zmiana będzie widoczna w odczycie.
  if (
    bonus.status === "done" &&
    bonus.appliedNow &&
    bonus.balanceAfter !== undefined
  ) {
    return bonus.balanceAfter;
  }

  return readBalance(email, cardCode);
}
