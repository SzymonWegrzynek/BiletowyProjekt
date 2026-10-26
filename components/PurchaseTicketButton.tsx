"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  reservationId: string;
};

export function PurchaseTicketButton({ reservationId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePurchase() {
    if (loading) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/reservations/${reservationId}/purchase`,
        {
          method: "POST",
        },
      );
      const json = await response.json().catch(() => null);

      if (response.status === 201 || response.status === 200) {
        const code = typeof json?.code === "string" ? json.code : null;
        if (!code) {
          setError("Brak numeru biletu w odpowiedzi serwera.");
          return;
        }

        router.push(`/bilet/${code}`);
        return;
      }

      if (response.status === 410) {
        router.refresh();
        setError("Rezerwacja wygasła, miejsce wróciło do puli");
        return;
      }

      setError(json?.error ?? "Nie udało się kupić biletu.");
    } catch {
      setError("Nie udało się kupić biletu. Spróbuj ponownie.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handlePurchase}
        disabled={loading}
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Kupuję bilet…" : "Kupuję bilet"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </>
  );
}
