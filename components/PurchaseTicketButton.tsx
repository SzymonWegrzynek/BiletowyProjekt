"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useExpireReservation } from "@/components/ReservationTimer";
import { Spinner } from "@/components/Spinner";

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
  const expireTimer = useExpireReservation();

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

      if (response.status === 410) {
        // W liczniku: przełącz cały licznik na „wygasła”; poza nim — własny komunikat.
        if (expireTimer) expireTimer();
        else setExpired(true);
        return;
      }
      setError(json?.error ?? GENERIC_MESSAGE);
    } catch {
      setError(GENERIC_MESSAGE);
    }
    setLoading(false);
  }

  if (expired) {
    return (
      <div role="alert" className="flex flex-col items-center gap-6">
        <p className="alert w-full text-center">{EXPIRED_MESSAGE}</p>
        <Link
          href={`/spektakl/${encodeURIComponent(eventId)}`}
          className="btn-secondary"
        >
          Wróć do widowni
        </Link>
      </div>
    );
  }

  return (
    <>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handlePurchase}
        disabled={loading}
        className="btn-primary w-full"
      >
        {loading && <Spinner />}
        {loading ? "Kupuję bilet…" : "Kupuję bilet"}
      </button>
    </>
  );
}
