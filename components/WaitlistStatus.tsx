"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatSeat } from "@/lib/format";
import { remainingOfferSeconds } from "@/lib/waitlist";
import {
  watchWaitlist,
  waitlistApi,
  WaitlistRequestError,
  type WaitlistApi,
  type WaitlistViewState,
} from "@/lib/waitlist-client";

export function WaitlistStatus({
  id,
  api = waitlistApi,
}: {
  id: string;
  api?: WaitlistApi;
}) {
  const [state, setState] = useState<WaitlistViewState>({ status: "loading" });
  const [now, setNow] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const lock = useRef(false);
  const watcher = useRef<ReturnType<typeof watchWaitlist> | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    watcher.current = watchWaitlist(id, setState, api);
    return () => {
      generation.current += 1;
      watcher.current?.stop();
      lock.current = false;
    };
  }, [id, api]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function leave() {
    if (lock.current) return;
    lock.current = true;
    const currentGeneration = generation.current;
    setLeaving(true);
    setLeaveError(null);
    watcher.current?.stop();
    try {
      await api.leave(id);
      if (generation.current !== currentGeneration) return;
      setState({ status: "left", position: 0 });
      setConfirming(false);
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      setLeaveError(
        error instanceof WaitlistRequestError && error.status === 409
          ? "Stan oferty się zmienił. Sprawdzamy go ponownie; opłacony bilet pozostaje ważny."
          : "Nie udało się wypisać. Spróbuj ponownie.",
      );
      watcher.current = watchWaitlist(id, setState, api);
    } finally {
      if (generation.current === currentGeneration) {
        lock.current = false;
        setLeaving(false);
      }
    }
  }
  const canLeave = state.status === "waiting" || state.status === "offered";
  return (
    <section className="card mx-auto max-w-xl p-6 sm:p-10">
      <WaitlistStatusContent state={state} now={now} />
      {state.status === "error" && (
        <button
          className="btn-secondary mt-6"
          onClick={() => watcher.current?.refresh()}
        >
          Sprawdź ponownie
        </button>
      )}
      {leaveError && (
        <p role="alert" className="alert mt-5">
          {leaveError}
        </p>
      )}
      {canLeave && (
        <div className="mt-8 border-t border-line pt-6">
          {confirming ? (
            <div role="group" aria-label="Potwierdź wypisanie">
              <p>
                Czy chcesz się wypisać? Utracisz pozycję i ewentualną
                nieopłaconą ofertę.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  className="btn-primary"
                  disabled={leaving}
                  onClick={() => void leave()}
                >
                  {leaving ? "Wypisuję…" : "Tak, wypisz mnie"}
                </button>
                <button
                  className="btn-secondary"
                  disabled={leaving}
                  onClick={() => setConfirming(false)}
                >
                  Zostań na liście
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn-secondary"
              onClick={() => setConfirming(true)}
            >
              Wypisz mnie
            </button>
          )}
        </div>
      )}
      <Link className="mt-8 inline-block text-sm text-muted underline" href="/">
        Wróć do repertuaru
      </Link>
    </section>
  );
}

// Osobny widok umożliwia test wszystkich stanów bez backendu kolejki.
export function WaitlistStatusContent({
  state,
  now,
}: {
  state: WaitlistViewState;
  now: number | null;
}) {
  const heading = {
    loading: "Sprawdzam kolejkę…",
    error: "Nie udało się odświeżyć kolejki",
    missing: "Nie ma takiego zapisu",
    waiting: "Jesteś na liście oczekujących",
    offered: "Mamy dla Ciebie miejsce",
    done: "Sprawdzamy Twój bilet",
    missed: "Nie zdążyłeś — miejsce przeszło dalej",
    left: "Wypisano Cię z listy",
    ticket: "Twój bilet jest gotowy",
  }[state.status];
  const seconds =
    state.status === "offered" && now !== null
      ? remainingOfferSeconds(state.offerExpiresAt, now)
      : 0;
  return (
    <div aria-live="polite">
      <p className="label">Lista oczekujących</p>
      <h1 className="title mt-3 text-3xl sm:text-4xl">{heading}</h1>
      {state.status === "waiting" && (
        <>
          <p className="mt-6 text-muted">Twoja aktualna pozycja</p>
          <p className="mt-2 text-5xl text-gold numerals">{state.position}</p>
          <p className="mt-5 text-sm text-muted">
            Odświeżamy stan co kilka sekund. Zapis nie gwarantuje miejsca.
          </p>
        </>
      )}
      {state.status === "offered" && (
        <>
          <p className="mt-6">
            {state.seatId
              ? formatSeat(state.seatId)
              : "Szczegóły przydzielonego miejsca znajdziesz na stronie rezerwacji."}
          </p>
          <p className="mt-3 text-muted">
            Oferta ważna do{" "}
            {new Intl.DateTimeFormat("pl-PL", {
              timeZone: "Europe/Warsaw",
              dateStyle: "short",
              timeStyle: "medium",
            }).format(new Date(state.offerExpiresAt))}{" "}
            (czas Warszawy).
          </p>
          {now === null ? (
            <p className="mt-4">Sprawdzam czas oferty…</p>
          ) : seconds > 0 ? (
            <>
              <p
                role="timer"
                aria-live="off"
                className="mt-4 text-3xl text-gold numerals"
              >
                {Math.floor(seconds / 60)}:
                {String(seconds % 60).padStart(2, "0")}
              </p>
              <Link
                href={`/rezerwacja/${encodeURIComponent(state.reservationId)}`}
                className="btn-primary mt-6"
                onClick={(event) => {
                  if (
                    remainingOfferSeconds(state.offerExpiresAt, Date.now()) ===
                    0
                  )
                    event.preventDefault();
                }}
              >
                Zapłać
              </Link>
              <p className="mt-3 text-sm text-muted">
                Na stronie rezerwacji możesz też użyć punktów.
              </p>
            </>
          ) : (
            <p role="status" className="alert mt-5">
              Czas oferty minął. Sprawdzamy jej aktualny stan — nie rozpoczynaj
              nowej płatności.
            </p>
          )}
        </>
      )}
      {state.status === "ticket" && (
        <Link
          className="btn-primary mt-6"
          href={`/bilet/${encodeURIComponent(state.code)}`}
        >
          Zobacz bilet
        </Link>
      )}
      {state.status === "done" && (
        <p className="mt-5 text-muted">
          Czekamy na potwierdzony kod biletu. Nie płać ponownie.
        </p>
      )}
      {state.status === "left" && (
        <p className="mt-5 text-muted">
          Nie będziesz już otrzymywać ofert z tego zapisu.
        </p>
      )}
      {state.status === "error" && (
        <p className="alert mt-5">
          Nie pokazujemy poprzedniej pozycji jako aktualnej. Automatycznie
          ponowimy sprawdzenie.
        </p>
      )}
    </div>
  );
}
