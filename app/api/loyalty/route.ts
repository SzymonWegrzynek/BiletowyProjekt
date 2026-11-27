import { apiError } from "@/lib/errors";
import { getLoyaltyBalance } from "@/lib/loyalty-account";
import { loyaltyEmailSchema } from "@/lib/schemas";
import {
  LOYALTY_RETRY_AFTER_SECONDS,
  LoyaltyUnavailableError,
  VoucherifyRequestError,
} from "@/lib/voucherify";

// Saldo zmienia się także poza aplikacją — żadnego cache po drodze.
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/loyalty?email=… → { email, points }. Nowy klient dostaje
// 1000 punktów. Awaria Voucherify daje 503, nigdy saldo 0.
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
