"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useRef, useState } from "react";

type Props = {
  reservationId: string;
  eventId: string;
  expiresAt: string;
};

export function PurchaseTicketButton({
  reservationId,
  eventId,
  expiresAt,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const purchasing = useRef(false);

  async function handlePurchase() {
    if (purchasing.current || expired) return;
    if (Date.now() >= new Date(expiresAt).getTime()) {
      setExpired(true);
      return;
    }

    purchasing.current = true;
    setLoading(true);
    setError(null);
    let navigating = false;

    try {
      const response = await fetch(
        `/api/reservations/${encodeURIComponent(reservationId)}/purchase`,
        {
          method: "POST",
        },
      );
      const json = await response.json().catch(() => null);

      if (response.status === 201 || response.status === 200) {
        const code = typeof json?.code === "string" ? json.code.trim() : null;
        if (!code) {
          setError("Brak numeru biletu w odpowiedzi serwera.");
          return;
        }

        router.push(`/bilet/${encodeURIComponent(code)}`);
        navigating = true;
        return;
      }

      if (response.status === 410) {
        setExpired(true);
        return;
      }

      setError(
        typeof json?.error === "string"
          ? json.error
          : "Nie udało się kupić biletu.",
      );
    } catch {
      setError("Nie udało się kupić biletu. Spróbuj ponownie.");
    } finally {
      if (!navigating) {
        purchasing.current = false;
        setLoading(false);
      }
    }
  }

  if (expired) {
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="text-lg font-medium text-red-600">
          Rezerwacja wygasła, miejsce wróciło do puli
        </p>
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
        aria-busy={loading}
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
