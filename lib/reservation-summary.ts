import { z } from "zod";
import type { Reservation } from "@/lib/schemas";
import { formatPrice } from "./format.ts";

const storedSettlementSchema = z
  .object({
    amount: z.number().int().nonnegative(),
    cardAmount: z.number().int().nonnegative(),
    pointsUsed: z.number().int().nonnegative(),
    pointsEarned: z.number().int().nonnegative(),
  })
  .refine((data) => data.cardAmount + data.pointsUsed === data.amount);

// Nie wyliczamy brakujących pól: komplet rozliczenia zapisują backendy A/B.
export function getStoredSettlement(reservation: Reservation) {
  const parsed = storedSettlementSchema.safeParse(reservation);
  return parsed.success ? parsed.data : null;
}

// Wspólne etykiety i formatowanie strony biletu oraz maila.
export function settlementRows(
  reservation: Reservation,
): [string, string][] | null {
  const settlement = getStoredSettlement(reservation);
  if (
    reservation.status !== "purchased" ||
    !reservation.code?.trim() ||
    !settlement
  )
    return null;
  return [
    ["Zapłacono kartą", formatPrice(settlement.cardAmount)],
    ["Użyte punkty", settlement.pointsUsed.toLocaleString("pl-PL")],
    ["Zdobyte punkty", settlement.pointsEarned.toLocaleString("pl-PL")],
  ];
}

export function reservationSummary(reservation: Reservation, now = new Date()) {
  const paid = reservation.status === "purchased";
  if (paid && !reservation.code?.trim()) throw new Error("Missing ticket code");
  return {
    status: paid ? "paid" : reservation.expiresAt <= now ? "expired" : "held",
    // Starsze rekordy bez kwoty nie mogą dostać dzisiejszej ceny spektaklu.
    amount: reservation.amount ?? null,
    expiresAt: reservation.expiresAt.toISOString(),
    pointsUsed: reservation.pointsUsed ?? 0,
    ...(paid
      ? {
          code: reservation.code,
          ...(reservation.pointsEarned !== undefined
            ? { pointsEarned: reservation.pointsEarned }
            : {}),
          ...(reservation.cardAmount !== undefined
            ? { cardAmount: reservation.cardAmount }
            : {}),
        }
      : {}),
  };
}
