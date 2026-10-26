"use client";

import { useCallback, useEffect, useState } from "react";
import { ReservationForm } from "@/components/ReservationForm";

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const SEATS = Array.from({ length: 10 }, (_, index) => index + 1);

// Co tyle odświeżamy takenSeats, żeby wygasłe rezerwacje wracały na plan.
const REFRESH_MS = 15_000;
const SEAT_TAKEN_MESSAGE = "Ktoś był szybszy — wybierz inne miejsce";

type Props = {
  eventId: string;
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

export function SeatMap({ eventId, takenSeats: initialTakenSeats }: Props) {
  const [takenSeats, setTakenSeats] = useState(initialTakenSeats);
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Po 201 trwa nawigacja — nasze własne miejsce nie może wtedy „przepaść”.
  const [reserved, setReserved] = useState(false);

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

  function selectSeat(seatId: string) {
    setSelectedSeat(seatId);
    setNotice(null);
  }

  function handleSeatTaken() {
    setNotice(SEAT_TAKEN_MESSAGE);
    setSelectedSeat(null);
    void refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-gray-300 bg-gray-50 p-4">
        <div className="mx-auto mb-4 flex w-full max-w-xl items-center justify-center rounded bg-gray-200 py-2 text-sm font-semibold uppercase tracking-[0.2em] text-gray-700">
          Scena
        </div>
        <div className="space-y-2">
          {ROWS.map((row) => (
            <div key={row} className="grid grid-cols-10 gap-2">
              {SEATS.map((seat) => {
                const seatId = `${row}${seat}`;
                const taken = takenSeats.includes(seatId);
                const selected = activeSeat === seatId;

                return (
                  <button
                    key={seatId}
                    type="button"
                    aria-label={`Miejsce ${seatId}`}
                    aria-pressed={selected}
                    disabled={taken}
                    onClick={() => selectSeat(seatId)}
                    className={[
                      "flex h-10 items-center justify-center rounded-md border text-xs font-medium transition-colors",
                      taken
                        ? "cursor-not-allowed border-gray-300 bg-gray-300 text-gray-500"
                        : selected
                          ? "border-emerald-600 bg-emerald-100 text-emerald-900"
                          : "border-gray-300 bg-white text-gray-800 hover:border-emerald-600 hover:text-emerald-800",
                    ].join(" ")}
                  >
                    {seatId}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {message && (
        <p role="alert" className="text-sm text-red-600">
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
        <p className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-600">
          Wybierz wolne miejsce na widowni, aby zarezerwować bilet.
        </p>
      )}
    </div>
  );
}
