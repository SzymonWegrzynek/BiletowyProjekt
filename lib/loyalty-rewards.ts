import type { ObjectId } from "mongodb";
import { reservationsCollection } from "./db.ts";
import { ensureLoyaltyCard } from "./loyalty-account.ts";
import { applyLoyaltyOperation } from "./loyalty-operations.ts";
import {
  LoyaltyUnavailableError,
  VoucherifyRequestError,
} from "./voucherify.ts";

// 10 punktów za każdą pełną złotówkę zapłaconą kartą: floor(grosze / 100) * 10.
// Część opłacona punktami nie daje nagrody, niepełna złotówka też nie.
export function pointsForCardPayment(cardAmount: number): number {
  if (!Number.isSafeInteger(cardAmount) || cardAmount <= 0) return 0;
  return Math.floor(cardAmount / 100) * 10;
}

export const earnOperationId = (reservationId: string) =>
  `earn:${reservationId}`;

// Pola rozliczenia, które webhook zapisuje razem z biletem — jednym
// warunkowym zapisem held → purchased, więc nagroda jest liczona raz
// i zawsze od opłaconej sesji (nie od starej ani od ceny spektaklu).
export function purchaseRewardFields(cardAmount: number) {
  const pointsEarned = pointsForCardPayment(cardAmount);
  return {
    cardAmount,
    pointsEarned,
    // Zero punktów nie wymaga Voucherify — od razu rozliczone.
    pointsEarnedStatus: pointsEarned > 0 ? "pending" : "done",
  } as const;
}

export type RewardResult = "done" | "pending" | "none";

// Dopisuje klientowi nagrodę za opłacony zakup w Voucherify. Bezpieczne do
// wołania wiele razy (ponowiony webhook, skrypt naprawczy): dopisanie to
// operacja earn:<reservationId>, wykonywana najwyżej raz.
// Awaria Voucherify nie psuje biletu — nagroda zostaje "pending" do dokończenia.
export async function awardPurchasePoints(
  _id: ObjectId,
): Promise<RewardResult> {
  try {
    return await settlePurchaseReward(_id);
  } catch (error) {
    if (
      error instanceof LoyaltyUnavailableError ||
      error instanceof VoucherifyRequestError
    ) {
      console.error(
        `Nagroda za rezerwację ${_id.toHexString()} czeka na Voucherify`,
        error,
      );
      return "pending";
    }
    throw error;
  }
}

// To samo, ale awaria Voucherify leci dalej — skrypt naprawczy musi wiedzieć
// np. o limicie zapytań, żeby przerwać zamiast go przedłużać.
export async function settlePurchaseReward(
  _id: ObjectId,
): Promise<RewardResult> {
  const reservations = reservationsCollection();
  const reservation = await reservations.findOne(
    { _id, status: "purchased" },
    { projection: { email: 1, pointsEarned: 1, pointsEarnedStatus: 1 } },
  );
  if (!reservation?.pointsEarned || !reservation.pointsEarnedStatus) {
    return "none";
  }
  if (reservation.pointsEarnedStatus === "done") return "done";

  const reservationId = _id.toHexString();
  const email = reservation.email.toLowerCase();
  const cardCode = await ensureLoyaltyCard(email);
  const result = await applyLoyaltyOperation({
    id: earnOperationId(reservationId),
    email,
    cardCode,
    points: reservation.pointsEarned,
    reason: `Nagroda za bilet (rezerwacja ${reservationId})`,
  });
  // W toku / do rozstrzygnięcia / odrzucona: nagroda zostaje "pending",
  // żeby było widać, że wymaga dokończenia.
  if (result.status !== "done") return "pending";

  await reservations.updateOne(
    { _id, pointsEarnedStatus: "pending" },
    { $set: { pointsEarnedStatus: "done" } },
  );
  return "done";
}
