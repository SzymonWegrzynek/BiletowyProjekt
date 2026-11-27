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

// Aktualne saldo klienta. Nowemu klientowi najpierw przyznaje bonus — raz,
// bo bonus to operacja o stałym id. Saldo zawsze z Voucherify, nie z bazy.
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

  return (await getLoyaltyCard(cardCode)).balance;
}
