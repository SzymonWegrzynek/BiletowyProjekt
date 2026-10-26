"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const EXPIRED_MESSAGE = "Rezerwacja wygasła, miejsce wróciło do puli";
const GENERIC_MESSAGE = "Nie udało się kupić biletu. Spróbuj ponownie.";

type Props = {
  reservationId: string;
  eventId: string;
};

export function PurchaseTicketButton({ reservationId, eventId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  async function handlePurchase() {
    if (loading) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/reservations/${encodeURIComponent(reservationId)}/purchase`,
        { method: "POST" },
      );
      const json = await response.json().catch(() => null);

      // 201 = nowy bilet, 200 = ponowiony zakup zwrócił ten sam kod.
      // Bez kodu z serwera nigdy nie pokazujemy biletu.
      if (response.ok && typeof json?.code === "string" && json.code) {
        // Przycisk zostaje zablokowany do końca nawigacji.
        router.push(`/bilet/${encodeURIComponent(json.code)}`);
        return;
      }

      if (response.status === 410) setExpired(true);
      else setError(json?.error ?? GENERIC_MESSAGE);
    } catch {
      setError(GENERIC_MESSAGE);
    }
    setLoading(false);
  }

  if (expired) {
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="text-lg font-medium text-red-600">{EXPIRED_MESSAGE}</p>
        <Link
          href={`/spektakl/${encodeURIComponent(eventId)}`}
          className="underline"
        >
          Wróć do widowni
        </Link>
      </div>
    );
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
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}
