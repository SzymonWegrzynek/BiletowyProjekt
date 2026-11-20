"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckoutError, retryPayment } from "@/lib/payment-retry";
import { formatPrice } from "@/lib/format";
import {
  loadLoyaltyBalance,
  loyaltyEmailSchema,
  type LoyaltyState,
} from "@/lib/loyalty";
import { getPointsPreview } from "@/lib/checkout-points";
import { CheckoutPoints } from "@/components/CheckoutPoints";

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
  email: string;
  cancelled?: boolean;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState("0");
  const [balance, setBalance] = useState<LoyaltyState>({ status: "loading" });
  const [balanceAttempt, setBalanceAttempt] = useState(0);
  const stopBalance = useRef<(() => void) | null>(null);
  const preview = getPointsPreview(amount, points, balance);

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
      setExpired(true);
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
        error instanceof CheckoutError
          ? error.message
          : "Nie udało się rozpocząć płatności. Spróbuj ponownie za chwilę.",
      );
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
    reservationId,
    cancelled,
    router,
    refreshBalance,
  ]);

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
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading
          ? "Przechodzę do płatności…"
          : preview.valid
            ? `Zapłać ${formatPrice(preview.cardAmount)}`
            : "Popraw liczbę punktów"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}
