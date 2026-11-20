import { z } from "zod";
import { createReservationSchema } from "@/lib/schemas";

export const loyaltyEmailSchema = createReservationSchema.shape.email.transform(
  (email) => email.toLowerCase(),
);
export const pointsSchema = z.number().int().nonnegative();
const balanceSchema = z.object({
  email: loyaltyEmailSchema,
  points: pointsSchema,
});

export type LoyaltyState =
  | { status: "loading" }
  | { status: "ready"; points: number }
  | { status: "error" };

// Jedno zapytanie po przerwie w pisaniu. Cleanup unieważnia także odpowiedź
// transportu, który nie respektuje AbortSignal.
export function loadLoyaltyBalance(
  email: string,
  onResult: (result: LoyaltyState) => void,
) {
  const controller = new AbortController();
  let active = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const parsed = loyaltyEmailSchema.safeParse(email);
  const timer = parsed.success
    ? setTimeout(async () => {
        timeout = setTimeout(() => {
          if (!active) return;
          active = false;
          controller.abort();
          onResult({ status: "error" });
        }, 10_000);
        try {
          const response = await fetch(
            `/api/loyalty?${new URLSearchParams({ email: parsed.data })}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error("Loyalty unavailable");
          const balance = balanceSchema.parse(await response.json());
          if (balance.email !== parsed.data) throw new Error("Email mismatch");
          if (active) onResult({ status: "ready", points: balance.points });
        } catch {
          if (active) onResult({ status: "error" });
        } finally {
          clearTimeout(timeout);
        }
      }, 400)
    : undefined;

  return () => {
    active = false;
    clearTimeout(timer);
    clearTimeout(timeout);
    controller.abort();
  };
}
