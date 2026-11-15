"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { retryPayment } from "@/lib/payment-retry";
import { formatPrice } from "@/lib/format";

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

  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [router]);

  async function pay() {
    if (busy.current || expired) return;
    if (Date.parse(expiresAt) <= Date.now()) {
      setExpired(true);
      return;
    }
    busy.current = true;
    setLoading(true);
    setError(null);
    let navigating = false;
    try {
      const result = await retryPayment(reservationId, cancelled);
      if (result.kind === "expired") setExpired(true);
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
      <div role="alert" className="flex flex-col gap-2">
        <p>Rezerwacja wygasła, miejsce wróciło do puli</p>
        <Link
          className="underline"
          href={`/spektakl/${encodeURIComponent(eventId)}`}
        >
          Wróć do widowni
        </Link>
      </div>
    );

  return (
    <>
      {cancelled && (
        <p role="status">
          Płatność przerwana. Możesz spróbować ponownie, dopóki trzymamy Twoje
          miejsce.
        </p>
      )}
      <button
        type="button"
        onClick={pay}
        disabled={loading}
        aria-busy={loading}
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Przechodzę do płatności…" : `Zapłać ${formatPrice(amount)}`}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}
