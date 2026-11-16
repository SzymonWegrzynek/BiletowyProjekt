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

export type EventDateParts = {
  weekday: string;
  day: string;
  month: string;
  year: string;
  long: string;
};

// "2026-11-14" → { weekday: "sobota", day: "14", month: "listopada", … }.
// Data spektaklu to dzień kalendarzowy, więc liczymy w UTC, bez strefy czasowej.
export function formatEventDate(date: string): EventDateParts | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;

  const value = new Date(Date.UTC(year, month - 1, day));
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("pl-PL", { timeZone: "UTC", ...options }).format(
      value,
    );

  const weekday = part({ weekday: "long" });
  const monthName = part({ day: "numeric", month: "long" }).replace(
    /^\d+\s/,
    "",
  );
  return {
    weekday,
    day: String(day),
    month: monthName,
    year: String(year),
    long: `${weekday}, ${day} ${monthName} ${year}`,
  };
}

// 6000 → "60 zł", 4550 → "45,50 zł". Kwoty są w groszach.
export function formatPrice(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Kwota musi być nieujemną liczbą całkowitą groszy");
  }
  return `${new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100)} zł`;
}
