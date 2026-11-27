import type { LoyaltyState } from "@/lib/loyalty";

export function getPointsPreview(
  amount: number,
  input: string,
  balance: LoyaltyState,
) {
  const limit = Math.floor(amount / 2);
  const maximum =
    balance.status === "ready" ? Math.min(balance.points, limit) : 0;
  const invalid = (error: string) => ({
    valid: false as const,
    error,
    maximum,
    limit,
  });
  if (!Number.isSafeInteger(amount) || amount < 0)
    return invalid("Nie udało się ustalić ceny rezerwacji.");
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input))) {
    return invalid(
      "Podaj nieujemną, całkowitą liczbę punktów (0 oznacza zakup bez punktów).",
    );
  }
  const points = Number(input);
  // Brak salda nie blokuje płatności w całości kartą.
  if (points > 0 && balance.status !== "ready") {
    return invalid("Poczekaj na aktualne saldo lub wybierz zakup bez punktów.");
  }
  if (points > maximum) {
    return invalid(
      `Możesz użyć maksymalnie ${maximum.toLocaleString("pl-PL")} punktów: nie więcej niż saldo i połowa ceny.`,
    );
  }
  return {
    valid: true as const,
    points,
    cardAmount: amount - points,
    maximum,
    limit,
  };
}
