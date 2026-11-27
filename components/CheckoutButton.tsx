"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckoutPoints } from "@/components/CheckoutPoints";
import { useExpireReservation } from "@/components/ReservationTimer";
import { Spinner } from "@/components/Spinner";
import { getPointsPreview } from "@/lib/checkout-points";
import { formatPrice } from "@/lib/format";
import {
  loadLoyaltyBalance,
  loyaltyEmailSchema,
  type LoyaltyState,
} from "@/lib/loyalty";
import { CheckoutError, retryPayment } from "@/lib/payment-retry";

export function CheckoutButton({
  reservationId,
  eventId,
  expiresAt,
  amount,
  email,
  cancelled = false,
}: {
  reservationId: string;
  eventId: string;
  expiresAt: string;
  amount: number;
  // Tylko do odczytu salda punktów (GET /api/loyalty); nie trafia do URL.
  email: string;
  cancelled?: boolean;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Etap III: wybór punktów. Podgląd dopłaty liczy UI, ale saldo i limit
  // sprawdza ponownie backend przy checkoucie.
  const [points, setPoints] = useState("0");
  const [balance, setBalance] = useState<LoyaltyState>({ status: "loading" });
  const [balanceAttempt, setBalanceAttempt] = useState(0);
  const stopBalance = useRef<(() => void) | null>(null);
  const preview = getPointsPreview(amount, points, balance);
  // W liczniku: wygaśnięcie przełącza cały licznik; poza nim — własny komunikat.
  const expireTimer = useExpireReservation();

  const markExpired = useCallback(() => {
    if (expireTimer) expireTimer();
    else setExpired(true);
  }, [expireTimer]);

  const refreshBalance = useCallback(() => {
    stopBalance.current?.();
    setBalance({ status: "loading" });
    setBalanceAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (!loyaltyEmailSchema.safeParse(email).success) {
      const timer = setTimeout(() => setBalance({ status: "error" }), 0);
      return () => clearTimeout(timer);
    }
    const stop = loadLoyaltyBalance(email, setBalance);
    stopBalance.current = stop;
    return stop;
  }, [email, balanceAttempt]);

  useEffect(() => {
    const refresh = () => {
      if (busy.current) return;
      refreshBalance();
      router.refresh();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [router, refreshBalance]);

  const pay = useCallback(async () => {
    if (busy.current || expired) return;
    if (!preview.valid) {
      setError(preview.error);
      return;
    }
    if (Date.parse(expiresAt) <= Date.now()) {
      markExpired();
      return;
    }
    busy.current = true;
    setLoading(true);
    setError(null);
    let navigating = false;
    try {
      const result = await retryPayment(
        reservationId,
        cancelled,
        preview.points,
      );
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
        error instanceof CheckoutError
          ? error.message
          : "Nie udało się rozpocząć płatności. Spróbuj ponownie za chwilę.",
      );
      // Odrzucony checkout z punktami — saldo mogło się zmienić.
      if (error instanceof CheckoutError && preview.points > 0)
        refreshBalance();
    } finally {
      if (!navigating) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [
    expired,
    preview,
    expiresAt,
    markExpired,
    reservationId,
    cancelled,
    router,
    refreshBalance,
  ]);

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
      <CheckoutPoints
        amount={amount}
        value={points}
        balance={balance}
        disabled={loading}
        onChange={(value) => {
          setPoints(value);
          setError(null);
        }}
        onRefresh={refreshBalance}
      />
      <button
        type="button"
        onClick={pay}
        disabled={loading || !preview.valid}
        aria-busy={loading}
        className="btn-primary w-full"
      >
        {loading && <Spinner />}
        {loading
          ? "Przechodzę do płatności…"
          : preview.valid
            ? `Zapłać ${formatPrice(preview.cardAmount)}`
            : "Popraw liczbę punktów"}
      </button>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </>
  );
}
