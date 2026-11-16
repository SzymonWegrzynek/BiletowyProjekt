"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
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
      <section className="flex flex-col items-center gap-8 text-center">
        <h1 className="title text-4xl">Nie ma takiej rezerwacji</h1>
        <Link href="/" className="btn-secondary">
          Wróć do repertuaru
        </Link>
      </section>
    );

  if (state.status === "expired")
    return (
      <section className="flex flex-col items-center gap-8 text-center">
        <h1 className="title text-3xl leading-snug text-cinnabar">
          Rezerwacja wygasła, miejsce wróciło do puli
        </h1>
        <Link
          href={eventId ? `/spektakl/${encodeURIComponent(eventId)}` : "/"}
          className="btn-secondary"
        >
          {eventId ? "Wróć do widowni" : "Wróć do repertuaru"}
        </Link>
      </section>
    );

  return (
    <section
      className="flex flex-col items-center gap-6 text-center"
      aria-live="polite"
    >
      <div className="flex items-center gap-4 text-gold" role="status">
        <span className="[&_svg]:size-7">
          <Spinner />
        </span>
        <h1 className="title text-4xl">
          {state.status === "paid"
            ? "Otwieram Twój bilet…"
            : "Płatność w toku…"}
        </h1>
      </div>
      {delayed && state.status !== "paid" ? (
        <>
          <p className="max-w-sm text-ink">
            Potwierdzenie płatności trwa dłużej niż zwykle. Nie płać ponownie —
            bilet pojawi się tutaj.
          </p>
          <button
            type="button"
            onClick={() => watcher.current?.retry()}
            disabled={checking}
            className="btn-primary w-full max-w-xs"
          >
            {checking && <Spinner />}
            {checking ? "Sprawdzam…" : "Sprawdź ponownie"}
          </button>
        </>
      ) : (
        <p className="max-w-sm text-muted">
          Czekamy na potwierdzenie płatności. Bilet pojawi się automatycznie.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="alert">
          Nie udało się sprawdzić płatności. Ponawiamy sprawdzenie — nie płać
          ponownie.
        </p>
      )}
    </section>
  );
}
