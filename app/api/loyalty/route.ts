import { apiError } from "@/lib/errors";
import { getLoyaltyBalance } from "@/lib/loyalty-account";
import { settleCustomerLoyalty } from "@/lib/loyalty-recovery";
import { clientIp, takeLoyaltySlot } from "@/lib/rate-limit";
import { loyaltyEmailSchema } from "@/lib/schemas";
import {
  LOYALTY_RETRY_AFTER_SECONDS,
  LoyaltyUnavailableError,
  VoucherifyRequestError,
} from "@/lib/voucherify";

// Saldo zmienia się także poza aplikacją — żadnego cache HTTP po drodze.
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/loyalty?email=… → { email, points }. Nowy klient dostaje
// 1000 punktów. Awaria Voucherify daje 503, nigdy saldo 0. Za dużo odczytów
// z jednego IP → 429 z Retry-After (limit chroni limit zapytań Voucherify).
export async function GET(request: Request) {
  const parsed = loyaltyEmailSchema.safeParse(
    new URL(request.url).searchParams.get("email") ?? undefined,
  );
  if (!parsed.success) {
    return apiError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Niepoprawny adres e-mail",
      NO_STORE,
    );
  }
  const email = parsed.data;

  // Po walidacji, przed pierwszym zapytaniem do Voucherify — jak w rezerwacji.
  const retryAfter = await takeLoyaltySlot(clientIp(request), new Date());
  if (retryAfter !== null) {
    return apiError(
      "RATE_LIMITED",
      "Za dużo zapytań o saldo punktów. Spróbuj ponownie za chwilę.",
      { ...NO_STORE, "Retry-After": String(retryAfter) },
    );
  }

  // Najpierw zaległe rozliczenia tego klienta (nagroda za zakup po awarii
  // Voucherify, zwrot punktów z wygasłej rezerwacji) — bez harmonogramu,
  // więc saldo od razu je uwzględnia. Błędy tylko w logach.
  await settleCustomerLoyalty(email);

  try {
    const points = await getLoyaltyBalance(email);
    return Response.json({ email, points }, { headers: NO_STORE });
  } catch (error) {
    if (
      error instanceof LoyaltyUnavailableError ||
      error instanceof VoucherifyRequestError
    ) {
      // Szczegóły tylko w logach. VoucherifyRequestError przy odczycie to
      // problem konfiguracji kampanii, a nie błąd klienta.
      console.error(`Saldo punktów ${email} niedostępne`, error);
      const retryAfter =
        error instanceof LoyaltyUnavailableError && error.retryAfterSeconds
          ? error.retryAfterSeconds
          : LOYALTY_RETRY_AFTER_SECONDS;
      return apiError("LOYALTY_UNAVAILABLE", undefined, {
        ...NO_STORE,
        "Retry-After": String(retryAfter),
      });
    }
    throw error;
  }
}
