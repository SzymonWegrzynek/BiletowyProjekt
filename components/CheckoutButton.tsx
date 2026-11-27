"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useExpireReservation } from "@/components/ReservationTimer";
import { Spinner } from "@/components/Spinner";
import { formatPrice } from "@/lib/format";
import { retryPayment } from "@/lib/payment-retry";

export function CheckoutButton({
  reservationId,
  eventId,
  expiresAt,
  amount,
  cancelled = false,
}: {
  reservationId: string;
  eventId: string;
  expiresAt: string;
  amount: number;
  cancelled?: boolean;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // W liczniku: wygaśnięcie przełącza cały licznik; poza nim — własny komunikat.
  const expireTimer = useExpireReservation();

  function markExpired() {
    if (expireTimer) expireTimer();
    else setExpired(true);
  }

  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [router]);

  async function pay() {
    if (busy.current || expired) return;
    if (Date.parse(expiresAt) <= Date.now()) {
      markExpired();
      return;
    }
    busy.current = true;
    setLoading(true);
    setError(null);
    let navigating = false;
    try {
      const result = await retryPayment(reservationId, cancelled);
      if (result.kind === "expired") markExpired();
      else if (result.kind === "paid") {
        router.replace(`/bilet/${encodeURIComponent(result.code)}`);
        navigating = true;
      } else {
        window.location.assign(result.url);
        navigating = true;
      }
    } catch (error) {
      setError(
        error instanceof Error &&
          error.message === "Płatności chwilowo niedostępne, spróbuj za chwilę."
          ? error.message
          : "Nie udało się rozpocząć płatności. Spróbuj ponownie za chwilę.",
      );
    } finally {
      if (!navigating) {
        busy.current = false;
        setLoading(false);
      }
    }
  }

  if (expired)
    return (
      <div role="alert" className="flex flex-col items-center gap-6">
        <p className="alert w-full text-center">
          Rezerwacja wygasła, miejsce wróciło do puli
        </p>
        <Link
          className="btn-secondary"
          href={`/spektakl/${encodeURIComponent(eventId)}`}
        >
          Wróć do widowni
        </Link>
      </div>
    );

  return (
    <>
      {cancelled && (
        <p
          role="status"
          className="rounded-2xl border border-gold/30 bg-gold-soft px-4 py-3 text-sm text-ink"
        >
          Płatność przerwana. Możesz spróbować ponownie, dopóki trzymamy Twoje
          miejsce.
        </p>
      )}
      <button
        type="button"
        onClick={pay}
        disabled={loading}
        aria-busy={loading}
        className="btn-primary w-full"
      >
        {loading && <Spinner />}
        {loading ? "Przechodzę do płatności…" : `Zapłać ${formatPrice(amount)}`}
      </button>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </>
  );
}
