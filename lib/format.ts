// "F7" → "Rząd F, miejsce 7". Zakłada seatId zgodny z seatIdSchema.
export function formatSeat(seatId: string): string {
  return `Rząd ${seatId.slice(0, 1)}, miejsce ${seatId.slice(1)}`;
}

// Pozostały czas w ms → "MM:SS", zaokrąglony w górę, żeby 00:00 znaczyło koniec.
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
export function formatPrice(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Kwota musi być nieujemną liczbą całkowitą groszy");
  }
  return `${new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100)} zł`;
}
