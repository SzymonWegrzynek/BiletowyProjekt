"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ReservationForm } from "@/components/ReservationForm";
import { formatEventDate, formatSeat } from "@/lib/format";
import type { Event } from "@/lib/schemas";

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const SEATS = Array.from({ length: 10 }, (_, index) => index + 1);
// Przejście między fotelami 5 i 6, jak w prawdziwej widowni.
const AISLE_AFTER = 5;

// Co tyle odświeżamy takenSeats, żeby wygasłe rezerwacje wracały na plan.
const REFRESH_MS = 15_000;
const SEAT_TAKEN_MESSAGE = "Ktoś był szybszy — wybierz inne miejsce";

type Props = {
  event: Event;
  takenSeats: string[];
};

function parseTakenSeats(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || !("takenSeats" in body)) {
    return null;
  }
  const { takenSeats } = body;
  if (!Array.isArray(takenSeats)) return null;
  return takenSeats.every((seat) => typeof seat === "string")
    ? takenSeats
    : null;
}

export function SeatMap({ event, takenSeats: initialTakenSeats }: Props) {
  const eventId = event._id;
  const [takenSeats, setTakenSeats] = useState(initialTakenSeats);
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Po 201 trwa nawigacja — nasze własne miejsce nie może wtedy „przepaść”.
  const [reserved, setReserved] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const seats = parseTakenSeats(await response.json());
      if (seats) setTakenSeats(seats);
    } catch {
      // Zostaje ostatni znany stan — spróbujemy przy następnym odświeżeniu.
    }
  }, [eventId]);

  useEffect(() => {
    if (reserved) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = setInterval(refreshIfVisible, REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh, reserved]);

  // Wybrany fotel zajął w międzyczasie ktoś inny (wynik odświeżenia).
  const selectionLost =
    !reserved && selectedSeat !== null && takenSeats.includes(selectedSeat);
  const activeSeat = selectionLost ? null : selectedSeat;
  const message = notice ?? (selectionLost ? SEAT_TAKEN_MESSAGE : null);
  const freeCount = ROWS.length * SEATS.length - takenSeats.length;
  const date = formatEventDate(event.date);

  function selectSeat(seatId: string) {
    setSelectedSeat(seatId);
    setNotice(null);
    // Na węższym ekranie formularz jest pod planem — przewijamy do niego.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches;
      requestAnimationFrame(() =>
        panelRef.current?.scrollIntoView({
          behavior: smooth ? "smooth" : "auto",
          block: "start",
        }),
      );
    }
  }

  function handleSeatTaken() {
    setNotice(SEAT_TAKEN_MESSAGE);
    setSelectedSeat(null);
    void refresh();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)_21rem] lg:items-start">
      <aside className="card p-6 lg:p-7">
        <h2 className="title text-xl">Informacje</h2>
        <dl className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4 lg:grid-cols-1">
          <Fact
            label="Data"
            value={date ? `${date.day} ${date.month}` : event.date}
            hint={date?.weekday}
          />
          <Fact label="Godzina" value={event.time} numeric />
          <Fact label="Scena" value={event.stage} />
          <Fact label="Wolne miejsca" value={String(freeCount)} numeric />
        </dl>
      </aside>

      <section aria-label="Plan widowni" className="card px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-md">
          <div className="h-2 rounded-full bg-linear-to-r from-gold/0 via-gold/70 to-gold/0" />
          <p className="label mt-3 text-center">Scena</p>
        </div>

        <div className="mx-auto mt-10 flex max-w-lg flex-col gap-2 sm:gap-2.5">
          {ROWS.map((row) => (
            <div key={row} className="flex items-center gap-2 sm:gap-3">
              <span className="w-4 shrink-0 text-center text-xs font-medium text-muted">
                {row}
              </span>
              <div className="grid flex-1 grid-cols-[repeat(5,minmax(0,1fr))_0.5rem_repeat(5,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(5,minmax(0,1fr))_1.25rem_repeat(5,minmax(0,1fr))] sm:gap-2">
                {SEATS.map((seat) => {
                  const seatId = `${row}${seat}`;
                  const taken = takenSeats.includes(seatId);
                  return (
                    <SeatButton
                      key={seatId}
                      number={seat}
                      label={`${formatSeat(seatId)}${taken ? ", zajęte" : ""}`}
                      taken={taken}
                      selected={activeSeat === seatId}
                      aisleBefore={seat === AISLE_AFTER + 1}
                      onSelect={() => selectSeat(seatId)}
                    />
                  );
                })}
              </div>
              <span className="w-4 shrink-0 text-center text-xs font-medium text-muted">
                {row}
              </span>
            </div>
          ))}
        </div>

        <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted">
          <Legend className="border border-line bg-paper">Wolne</Legend>
          <Legend className="bg-gold">Twój wybór</Legend>
          <Legend className="bg-seat-taken">Zajęte</Legend>
        </ul>
      </section>

      <aside
        ref={panelRef}
        aria-live="polite"
        className="flex scroll-mt-6 flex-col gap-4"
      >
        {message && (
          <p role="alert" className="alert">
            {message}
          </p>
        )}

        {activeSeat ? (
          <ReservationForm
            key={activeSeat}
            eventId={eventId}
            seatId={activeSeat}
            onSeatTaken={handleSeatTaken}
            onReserved={() => setReserved(true)}
          />
        ) : (
          <div className="card p-7">
            <h2 className="title text-2xl">Rezerwacja</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Wybierz wolny fotel na planie widowni. Potem podasz imię i e-mail,
              a miejsce będzie na Ciebie czekać do zakupu biletu.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Fact({
  label,
  value,
  hint,
  numeric = false,
}: {
  label: string;
  value: string;
  hint?: string;
  numeric?: boolean;
}) {
  return (
    <div>
      <dt className="label text-muted">{label}</dt>
      <dd className={`mt-1 text-ink ${numeric ? "numerals" : ""}`}>{value}</dd>
      {hint && <dd className="text-sm text-muted">{hint}</dd>}
    </div>
  );
}

function Legend({
  className,
  children,
}: {
  className: string;
  children: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <span className={`size-3 rounded-[4px] ${className}`} />
      {children}
    </li>
  );
}

type SeatButtonProps = {
  number: number;
  label: string;
  taken: boolean;
  selected: boolean;
  aisleBefore: boolean;
  onSelect: () => void;
};

function SeatButton({
  number,
  label,
  taken,
  selected,
  aisleBefore,
  onSelect,
}: SeatButtonProps) {
  return (
    <>
      {aisleBefore && <span aria-hidden="true" />}
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        disabled={taken}
        onClick={onSelect}
        className={[
          "flex aspect-square items-center justify-center rounded-lg text-[10px] font-medium transition duration-200 numerals sm:text-[11px]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold",
          taken
            ? "cursor-not-allowed bg-seat-taken text-transparent"
            : selected
              ? "bg-gold font-semibold text-surface"
              : "border border-line bg-paper text-muted hover:border-gold hover:text-gold active:scale-95",
        ].join(" ")}
      >
        {number}
      </button>
    </>
  );
}
