export type PaymentRetryResult =
  | { kind: "paid"; code: string }
  | { kind: "expired" }
  | { kind: "checkout"; url: string };

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

// Stan i kwota pochodzą z serwera; powrót ze Stripe nie dowodzi płatności.
export async function retryPayment(
  reservationId: string,
  checkStatus = true,
  points?: number,
): Promise<PaymentRetryResult> {
  if (points !== undefined && (!Number.isSafeInteger(points) || points < 0)) {
    throw new Error("Podaj nieujemną, całkowitą liczbę punktów.");
  }
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
  const response = await fetch(`${path}/checkout`, {
    method: "POST",
    ...(points === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ points }),
        }),
  });
  if (response.status === 410) return { kind: "expired" };
  const data = await response.json().catch(() => null);
  const message =
    typeof data?.error === "string" && data.error.trim()
      ? data.error
      : "Nie udało się rozpocząć płatności. Sprawdź liczbę punktów i spróbuj ponownie.";
  if (response.status === 409) {
    // Konflikt punktów nie oznacza opłaconej rezerwacji.
    if (typeof data?.code === "string" && data.code !== "ALREADY_PAID") {
      throw new CheckoutError(message, response.status);
    }
    const updated = await readStatus();
    if (updated) return updated;
    throw new CheckoutError(
      data?.error
        ? message
        : "Stan płatności się zmienił. Sprawdź ponownie za chwilę.",
      409,
    );
  }
  if (response.status >= 400 && response.status < 500) {
    throw new CheckoutError(message, response.status);
  }
  if (!response.ok)
    throw new CheckoutError(
      "Płatności chwilowo niedostępne, spróbuj za chwilę.",
      response.status,
    );
  if (
    typeof data?.url !== "string" ||
    new URL(data.url).protocol !== "https:"
  ) {
    throw new Error("Nie udało się otworzyć płatności. Spróbuj ponownie.");
  }
  return { kind: "checkout", url: data.url };
}
