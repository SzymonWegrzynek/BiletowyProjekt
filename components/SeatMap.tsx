"use client";

import { useEffect, useState } from "react";
import { ReservationForm } from "@/components/ReservationForm";

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const SEATS = Array.from({ length: 10 }, (_, index) => index + 1);

type Props = {
  eventId: string;
  takenSeats: string[];
};

export function SeatMap({ eventId, takenSeats: initialTakenSeats }: Props) {
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [takenSeats, setTakenSeats] = useState(initialTakenSeats);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [seatMessage, setSeatMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(
          `/api/events/${encodeURIComponent(eventId)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("Nie udało się odświeżyć widowni");
        const data = await response.json();
        if (
          !Array.isArray(data.takenSeats) ||
          !data.takenSeats.every((seat: unknown) => typeof seat === "string")
        ) {
          throw new Error("Nieprawidłowe dane widowni");
        }
        if (controller.signal.aborted) return;
        setTakenSeats(data.takenSeats);
        setRefreshError(null);
      } catch {
        if (!controller.signal.aborted) {
          setRefreshError(
            "Nie udało się odświeżyć dostępności. Spróbujemy ponownie za chwilę.",
          );
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 15_000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [eventId, refreshVersion]);

  const isTaken = (seatId: string) => takenSeats.includes(seatId);
  const selectionTaken = selectedSeat !== null && isTaken(selectedSeat);

  return (
    <div className="flex flex-col gap-6">
      <div
        className="overflow-x-auto rounded-xl border border-gray-300 bg-gray-50 p-2 sm:p-4"
        aria-label="Plan widowni"
      >
        <div className="min-w-[500px]">
          <div className="theatre-stage mx-auto flex w-full max-w-xl items-center justify-center text-sm font-semibold uppercase tracking-[0.3em]">
            Scena
          </div>
          <div className="space-y-2">
            {ROWS.map((row) => (
              <div
                key={row}
                className="grid grid-cols-[1.5rem_repeat(10,minmax(0,1fr))] gap-1 sm:gap-2"
              >
                <span
                  className="flex items-center justify-center text-sm font-semibold"
                  aria-label={`Rząd ${row}`}
                >
                  {row}
                </span>
                {SEATS.map((seat) => {
                  const seatId = `${row}${seat}`;
                  const taken = isTaken(seatId);
                  const selected = selectedSeat === seatId && !taken;

                  return (
                    <button
                      key={seatId}
                      type="button"
                      aria-label={`Rząd ${row}, miejsce ${seat}${taken ? ", zajęte" : ", wolne"}`}
                      aria-pressed={selected}
                      disabled={taken}
                      onClick={() => {
                        setSelectedSeat(seatId);
                        setSeatMessage(null);
                      }}
                      className={[
                        "flex h-11 items-center justify-center rounded-md border text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700",
                        taken
                          ? "cursor-not-allowed border-gray-300 bg-gray-300 text-gray-500"
                          : selected
                            ? "border-emerald-600 bg-emerald-100 text-emerald-900"
                            : "border-gray-300 bg-white text-gray-800 hover:border-emerald-600 hover:text-emerald-800",
                      ].join(" ")}
                    >
                      {seat}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-sm text-gray-600">
        Jasne — wolne · Przygaszone — zajęte · Złote — wybrane. Dostępność
        odświeżamy co 15 sekund. Na małym ekranie przesuń plan w bok.
      </p>
      {refreshError && (
        <p role="status" className="text-sm text-amber-800">
          {refreshError}
        </p>
      )}
      {(seatMessage || selectionTaken) && (
        <p role="alert" className="text-sm text-red-600">
          {seatMessage ?? "Ktoś był szybszy — wybierz inne miejsce"}
        </p>
      )}

      {selectedSeat && !selectionTaken ? (
        <ReservationForm
          key={selectedSeat}
          eventId={eventId}
          seatId={selectedSeat}
          onSeatTaken={() => {
            setTakenSeats((seats) => [...seats, selectedSeat]);
            setSelectedSeat(null);
            setSeatMessage("Ktoś był szybszy — wybierz inne miejsce");
            setRefreshVersion((version) => version + 1);
          }}
        />
      ) : (
        <p className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-600">
          Wybierz wolne miejsce na widowni, aby zarezerwować bilet.
        </p>
      )}
    </div>
  );
}
