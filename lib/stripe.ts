import Stripe from "stripe";

// Stripe to zewnętrzna usługa: zapytanie nie może wisieć w nieskończoność.
// 8 s na próbę + 1 ponowienie (Stripe ponawia tylko bezpieczne przypadki,
// z własnym Idempotency-Key, więc nie powstanie druga sesja).
export const STRIPE_TIMEOUT_MS = 8_000;
export const STRIPE_MAX_NETWORK_RETRIES = 1;

// Po ilu sekundach klient może spróbować ponownie (nagłówek Retry-After przy 503).
export const PAYMENT_RETRY_AFTER_SECONDS = 5;

// Stripe przyjmuje expires_at sesji najwcześniej 30 min od utworzenia.
// Minuta zapasu na różnicę zegarów — okno „płatność po wygaśnięciu
// rezerwacji” ma być jak najkrótsze.
export const CHECKOUT_SESSION_TTL_MS = 31 * 60_000;

// Brak konfiguracji to błąd po naszej stronie: szczegóły idą do logów,
// klient dostaje tylko 503 „Płatności chwilowo niedostępne”.
export class PaymentConfigError extends Error {}

const globalForStripe = globalThis as typeof globalThis & {
  _stripe?: Stripe;
};

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new PaymentConfigError("Brak zmiennej STRIPE_SECRET_KEY");
  globalForStripe._stripe ??= new Stripe(key, {
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  });
  return globalForStripe._stripe;
}

// Adres aplikacji do success_url / cancel_url. Bierzemy go z env, nie z
// nagłówka Host, żeby nikt nie podstawił własnej domeny jako adresu powrotu.
export function getAppUrl(): string {
  const url = process.env.APP_URL?.trim();
  if (!url) throw new PaymentConfigError("Brak zmiennej APP_URL");
  return url.replace(/\/+$/, "");
}

// Czy błąd znaczy „płatności chwilowo nie działają” (→ 503), a nie błąd w
// naszym kodzie. Timeout i zerwane połączenie to StripeConnectionError.
export function isPaymentUnavailable(error: unknown): boolean {
  if (error instanceof PaymentConfigError) return true;
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError ||
    error instanceof Stripe.errors.StripeAuthenticationError
  ) {
    return true;
  }
  return (
    error instanceof Stripe.errors.StripeError && (error.statusCode ?? 0) >= 500
  );
}

// Wygaszenie starej sesji Checkout. Najlepszy wysiłek: sesja mogła już
// wygasnąć albo zostać opłacona — wtedy Stripe odmówi, a drugą płatność
// i tak obsługuje webhook (zwrot). Nie przerywamy przez to odpowiedzi.
// Zwraca true tylko, gdy Stripe potwierdził wygaszenie — wtedy sesji na pewno
// nie da się już opłacić (np. wolno oddać punkty wydane na tę próbę).
export async function expireCheckoutSessionQuietly(
  sessionId: string,
): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.expire(sessionId);
    return session?.status === "expired";
  } catch (error) {
    console.warn(`Nie udało się wygasić sesji Stripe ${sessionId}`, error);
    return false;
  }
}

// Weryfikacja podpisu webhooka. Statyczne Stripe.webhooks nie potrzebuje
// klucza API — wystarczy sekret webhooka (whsec_…).
// Zły podpis → StripeSignatureVerificationError.
export function constructWebhookEvent(
  body: string,
  signature: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new PaymentConfigError("Brak zmiennej STRIPE_WEBHOOK_SECRET");
  }
  return Stripe.webhooks.constructEvent(body, signature, secret);
}

export function isSignatureError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeSignatureVerificationError;
}

// Dlaczego oddajemy pieniądze — trafia do metadata zwrotu i do logów.
export type RefundReason =
  // Rezerwacja wygasła, a miejsce przejął ktoś inny (dokumentu już nie ma).
  | "reservation_gone"
  // Rezerwacja jest już opłacona inną sesją Checkout.
  | "duplicate_payment"
  // Sesja bez poprawnego id rezerwacji (nie z naszego /checkout).
  | "unknown_reservation"
  // Rezerwacja wygasła bez zapłaty i punkty wydane na nią już wróciły do
  // klienta — spóźniona płatność nie daje biletu ze zniżką, wraca w całości.
  | "points_released"
  // Punkty tej próby płatności zostały już oddane klientowi (np. sesja była
  // uznana za nieopłacalną) — bilet za dopłatę bez punktów byłby za tani.
  | "points_returned";

// Zwrot całej płatności sesji Checkout. Klient, który zapłacił, dostaje
// bilet albo zwrot — nigdy nic. Klucz idempotencji = id sesji, więc ponowiony
// webhook nie robi drugiego zwrotu (Stripe zwraca wynik pierwszego).
// Klient Stripe przychodzi z zewnątrz (getStripe() w route), żeby testy
// mogły go podmienić.
export async function refundPayment(
  stripe: Pick<Stripe, "refunds">,
  {
    sessionId,
    paymentIntentId,
    reservationId,
    reason,
  }: {
    sessionId: string;
    paymentIntentId: string;
    reservationId: string;
    reason: RefundReason;
  },
): Promise<void> {
  try {
    await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: { reservationId, checkoutSessionId: sessionId, reason },
      },
      { idempotencyKey: `refund-${sessionId}` },
    );
  } catch (error) {
    // Zwrot zrobiony już wcześniej (np. ręcznie w panelu) — cel osiągnięty.
    if (
      error instanceof Stripe.errors.StripeError &&
      error.code === "charge_already_refunded"
    ) {
      return;
    }
    throw error;
  }
  console.warn(
    `Zwrot płatności ${paymentIntentId} (sesja ${sessionId}, rezerwacja ${reservationId}): ${reason}`,
  );
}
