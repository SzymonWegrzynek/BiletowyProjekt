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
