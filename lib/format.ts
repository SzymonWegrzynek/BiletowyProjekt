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
