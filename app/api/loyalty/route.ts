import { apiError } from "@/lib/errors";
import { loyaltyEmailSchema } from "@/lib/loyalty";
import { STUB_LOYALTY_POINTS } from "@/lib/stubs";

// Tymczasowa zaślepka karty A. Backend zastąpi ją odczytem z Voucherify.
export async function GET(request: Request) {
  const email = loyaltyEmailSchema.safeParse(
    new URL(request.url).searchParams.get("email"),
  );
  const headers = { "Cache-Control": "no-store" };
  if (!email.success)
    return apiError("VALIDATION_ERROR", "Niepoprawny adres e-mail", headers);
  if (process.env.NODE_ENV === "production") {
    return apiError("LOYALTY_UNAVAILABLE", undefined, headers);
  }
  return Response.json(
    { email: email.data, points: STUB_LOYALTY_POINTS },
    { headers },
  );
}
