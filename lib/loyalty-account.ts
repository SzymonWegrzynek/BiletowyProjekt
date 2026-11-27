import { MongoServerError } from "mongodb";
import { loyaltyAccountsCollection } from "./db.ts";
import { applyLoyaltyOperation } from "./loyalty-operations.ts";
import {
  LoyaltyUnavailableError,
  getLoyaltyCard,
  joinLoyaltyProgram,
} from "./voucherify.ts";

const DUPLICATE_KEY = 11000;

// Nowy klient dostaje raz 1000 punktów (1 punkt = 1 grosz).
export const LOYALTY_WELCOME_BONUS = 1000;

export const welcomeBonusOperationId = (email: string) => `bonus:${email}`;

// Kod karty lojalnościowej klienta. Pierwszy odczyt dołącza klienta do
// kampanii w Voucherify i zapamiętuje kartę; kolejne biorą ją z bazy.
// email musi być już znormalizowany (loyaltyEmailSchema).
export async function ensureLoyaltyCard(email: string): Promise<string> {
  const accounts = loyaltyAccountsCollection();
  const existing = await accounts.findOne(
    { _id: email },
    { projection: { cardCode: 1 } },
  );
  if (existing?.cardCode) return existing.cardCode;

  const card = await joinLoyaltyProgram(email);
  const now = new Date();
  try {
    // Pierwszy zapis wygrywa. Voucherify i tak daje klientowi jedną kartę
    // w kampanii, więc równoległe wywołanie dostaje ten sam kod.
    await accounts.updateOne(
      { _id: email, cardCode: { $exists: false } },
      {
        $set: { cardCode: card.cardCode, joinedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  } catch (error) {
    // Dokument z kartą już jest (filtr nie pasował, upsert trafił w _id).
    if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) {
      throw error;
    }
  }

  const saved = await accounts.findOne(
    { _id: email },
    { projection: { cardCode: 1 } },
  );
  if (!saved?.cardCode) {
    throw new Error(`Konto punktowe ${email} bez karty po zapisie`);
  }
  return saved.cardCode;
}

// Aktualne saldo klienta. Nowemu klientowi najpierw przyznaje bonus — raz,
// bo bonus to operacja o stałym id. Saldo zawsze z Voucherify, nie z bazy.
export async function getLoyaltyBalance(email: string): Promise<number> {
  const cardCode = await ensureLoyaltyCard(email);

  const bonus = await applyLoyaltyOperation({
    id: welcomeBonusOperationId(email),
    email,
    cardCode,
    points: LOYALTY_WELCOME_BONUS,
    reason: "Bonus powitalny",
  });
  if (bonus.status === "in_progress") {
    // Bonus właśnie się nalicza. Saldo bez niego byłoby nieprawdziwe,
    // więc lepiej „spróbuj za chwilę” niż 0.
    throw new LoyaltyUnavailableError(
      `Bonus powitalny dla ${email} w trakcie naliczania`,
      "not_applied",
      1,
    );
  }
  // Saldo zaraz po przyznaniu bonusu podaje sam Voucherify — oszczędza
  // zapytanie i nie zależy od tego, kiedy zmiana będzie widoczna w odczycie.
  if (bonus.appliedNow && bonus.balanceAfter !== undefined) {
    return bonus.balanceAfter;
  }

  return (await getLoyaltyCard(cardCode)).balance;
}
