"use client";

import { useState } from "react";
import { ReservationForm } from "@/components/ReservationForm";

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const SEATS = Array.from({ length: 10 }, (_, index) => index + 1);

type Props = {
  eventId: string;
  takenSeats: string[];
};

export function SeatMap({ eventId, takenSeats }: Props) {
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);

  const isTaken = (seatId: string) => takenSeats.includes(seatId);

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
                const taken = isTaken(seatId);
                const selected = selectedSeat === seatId;

                return (
                  <button
                    key={seatId}
                    type="button"
                    aria-label={`Miejsce ${seatId}`}
                    aria-pressed={selected}
                    disabled={taken}
                    onClick={() => setSelectedSeat(seatId)}
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

      {selectedSeat ? (
        <ReservationForm
          eventId={eventId}
          seatId={selectedSeat}
          onSeatTaken={() => {
            setSelectedSeat(null);
            window.location.reload();
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
