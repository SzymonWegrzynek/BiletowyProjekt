export type PaymentRetryResult =
  | { kind: "paid"; code: string }
  | { kind: "expired" }
  | { kind: "checkout"; url: string };

// Stan i kwota pochodzą z serwera; powrót ze Stripe nie dowodzi płatności.
export async function retryPayment(
  reservationId: string,
  checkStatus = true,
): Promise<PaymentRetryResult> {
  const path = `/api/reservations/${encodeURIComponent(reservationId)}`;
  async function readStatus(): Promise<PaymentRetryResult | null> {
    const response = await fetch(path, { cache: "no-store" });
    if (response.status === 410) return { kind: "expired" };
    if (!response.ok)
      throw new Error("Nie udało się sprawdzić rezerwacji. Spróbuj ponownie.");
    const data = await response.json();
    if (
      data.status === "paid" &&
      typeof data.code === "string" &&
      data.code.trim()
    ) {
      return { kind: "paid", code: data.code };
    }
    if (data.status === "expired") return { kind: "expired" };
    if (
      data.status !== "held" ||
      !Number.isFinite(Date.parse(data.expiresAt))
    ) {
      throw new Error(
        "Nie udało się potwierdzić stanu rezerwacji. Spróbuj ponownie.",
      );
    }
    if (Date.parse(data.expiresAt) <= Date.now()) return { kind: "expired" };
    return null;
  }
  if (checkStatus) {
    const current = await readStatus();
    if (current) return current;
  }
  const response = await fetch(`${path}/checkout`, { method: "POST" });
  if (response.status === 410) return { kind: "expired" };
  if (response.status === 409) {
    const updated = await readStatus();
    if (updated) return updated;
    throw new Error("Stan płatności się zmienił. Sprawdź ponownie za chwilę.");
  }
  if (!response.ok)
    throw new Error("Płatności chwilowo niedostępne, spróbuj za chwilę.");
  const data = await response.json();
  if (typeof data.url !== "string" || new URL(data.url).protocol !== "https:") {
    throw new Error("Nie udało się otworzyć płatności. Spróbuj ponownie.");
  }
  return { kind: "checkout", url: data.url };
}
