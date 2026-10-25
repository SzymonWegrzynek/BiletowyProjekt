import type { Filter } from "mongodb";
import type { Reservation } from "@/lib/schemas";

// Jedyne miejsce, które zna domyślny czas ważności rezerwacji.
export function getTtlMinutes(): number {
  const ttl = Number(process.env.RESERVATION_TTL_MINUTES ?? 15);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("RESERVATION_TTL_MINUTES musi być dodatnią liczbą");
  }
  return ttl;
}

export function reservationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + getTtlMinutes() * 60_000);
}

// Miejsce jest zajęte, gdy bilet jest kupiony albo rezerwacja jeszcze nie wygasła.
// Wygasłe "held" pomijamy, więc nie potrzeba crona ani TTL index.
// Użycie: find({ eventId, ...activeReservationFilter(now) }); nie łącz z drugim $or przez spread.
export function activeReservationFilter(now: Date): Filter<Reservation> {
  return {
    $or: [{ status: "purchased" }, { status: "held", expiresAt: { $gt: now } }],
  };
}
