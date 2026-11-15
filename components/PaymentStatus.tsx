"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  watchPaymentStatus,
  type PaymentStatus as Status,
} from "@/lib/payment-status";

export function PaymentStatus({
  reservationId,
  eventId,
}: {
  reservationId: string;
  eventId: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<Status>({ status: "held" });
  const [delayed, setDelayed] = useState(false);
  const [checking, setChecking] = useState(false);
  const watcher = useRef<ReturnType<typeof watchPaymentStatus> | null>(null);

  useEffect(() => {
    const subscription = watchPaymentStatus(
      reservationId,
      (result) => {
        setState(result);
        if (result.status === "paid")
          router.replace(`/bilet/${encodeURIComponent(result.code)}`);
      },
      { onDelayed: () => setDelayed(true), onChecking: setChecking },
    );
    watcher.current = subscription;
    return () => {
      subscription();
      watcher.current = null;
    };
  }, [reservationId, router]);

  if (state.status === "missing")
    return (
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Nie ma takiej rezerwacji</h1>
        <Link href="/" className="underline">
          Wróć do repertuaru
        </Link>
      </section>
    );

  if (state.status === "expired")
    return (
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">
          Rezerwacja wygasła, miejsce wróciło do puli
        </h1>
        <Link
          href={eventId ? `/spektakl/${encodeURIComponent(eventId)}` : "/"}
          className="underline"
        >
          {eventId ? "Wróć do widowni" : "Wróć do repertuaru"}
        </Link>
      </section>
    );

  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <div className="flex items-center gap-3" role="status">
        <span
          aria-hidden="true"
          className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-emerald-700 motion-reduce:animate-none"
        />
        <h1 className="text-2xl font-semibold">
          {state.status === "paid"
            ? "Otwieram Twój bilet…"
            : "Płatność w toku…"}
        </h1>
      </div>
      {delayed && state.status !== "paid" ? (
        <>
          <p>
            Potwierdzenie płatności trwa dłużej niż zwykle. Nie płać ponownie —
            bilet pojawi się tutaj.
          </p>
          <button
            type="button"
            onClick={() => watcher.current?.retry()}
            disabled={checking}
            className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? "Sprawdzam…" : "Sprawdź ponownie"}
          </button>
        </>
      ) : (
        <p>
          Czekamy na potwierdzenie płatności. Bilet pojawi się automatycznie.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-amber-800">
          Nie udało się sprawdzić płatności. Ponawiamy sprawdzenie — nie płać
          ponownie.
        </p>
      )}
    </section>
  );
}
