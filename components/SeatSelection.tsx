"use client";

import { useEffect, useRef, useState } from "react";
import { ReservationForm } from "@/components/ReservationForm";
import { formatSeat } from "@/lib/format";
import { eventSchema, type Event } from "@/lib/schemas";

type EventDetails = {
  event: Event;
  takenSeats: string[];
};

const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const SEATS_PER_ROW = 10;
const REFRESH_INTERVAL_MS = 15_000;

export function SeatSelection({ eventId }: { eventId: string }) {
  const [details, setDetails] = useState<EventDetails | null>(null);
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const hasDetails = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const controller = new AbortController();

    async function refresh() {
      try {
        const response = await fetch(
          `/api/events/${encodeURIComponent(eventId)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const body: unknown = await response.json();

        if (!response.ok) {
          if (response.status === 404) setError("Nie ma takiego spektaklu");
          else if (!hasDetails.current)
            setError("Nie udało się wczytać widowni. Spróbuj ponownie.");
          return;
        }

        if (
          typeof body !== "object" ||
          body === null ||
          !("event" in body) ||
          !("takenSeats" in body) ||
          !Array.isArray(body.takenSeats) ||
          !body.takenSeats.every((seat) => typeof seat === "string")
        ) {
          if (!hasDetails.current)
            setError("Otrzymano nieprawidłowe dane widowni.");
          return;
        }

        const parsedEvent = eventSchema.safeParse(body.event);
        if (!parsedEvent.success) {
          if (!hasDetails.current)
            setError("Otrzymano nieprawidłowe dane spektaklu.");
          return;
        }

        const nextDetails = {
          event: parsedEvent.data,
          takenSeats: body.takenSeats,
        };
        if (!disposed) {
          hasDetails.current = true;
          setDetails(nextDetails);
          setSelectedSeat((current) =>
            current && nextDetails.takenSeats.includes(current)
              ? null
              : current,
          );
          setError(null);
        }
      } catch {
        if (!disposed && !hasDetails.current) {
          setError("Nie udało się wczytać widowni. Spróbuj ponownie.");
        }
      } finally {
        if (!disposed) timeout = setTimeout(refresh, REFRESH_INTERVAL_MS);
      }
    }

    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [eventId, refreshKey]);

  if (error && !details) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold">Widownia</h1>
        <p role="alert" className="text-red-700">
          {error}
        </p>
      </main>
    );
  }

  if (!details) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <p role="status">Wczytuję widownię…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="border-b border-gray-200 pb-6">
        <p className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Wybór miejsca
        </p>
        <h1 className="mt-2 text-3xl font-semibold">{details.event.title}</h1>
        <p className="mt-2 text-gray-600">
          {details.event.date} · {details.event.time} · {details.event.stage}
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <section aria-label="Plan widowni" className="min-w-0">
          <div className="mx-auto mb-8 max-w-xl rounded-t-[50%] border-t-4 border-gray-800 bg-gray-100 px-4 py-3 text-center text-sm font-semibold uppercase tracking-widest text-gray-700">
            Scena
          </div>

          <div className="mx-auto flex w-fit max-w-full flex-col gap-2 overflow-x-auto pb-2">
            {ROWS.map((row) => (
              <div key={row} className="flex items-center gap-1.5 sm:gap-2">
                <span className="w-5 shrink-0 text-center text-xs font-semibold text-gray-500">
                  {row}
                </span>
                {Array.from({ length: SEATS_PER_ROW }, (_, index) => {
                  const seatId = `${row}${index + 1}`;
                  const taken = details.takenSeats.includes(seatId);
                  const selected = selectedSeat === seatId;

                  return (
                    <button
                      key={seatId}
                      type="button"
                      disabled={taken}
                      aria-label={`${formatSeat(seatId)}${taken ? ", zajęte" : ""}`}
                      aria-pressed={selected}
                      onClick={() => setSelectedSeat(seatId)}
                      className={`h-7 w-6 shrink-0 rounded-t-md border text-[10px] font-medium transition-colors sm:h-8 sm:w-7 sm:text-xs ${
                        taken
                          ? "cursor-not-allowed border-gray-300 bg-gray-200 text-gray-400"
                          : selected
                            ? "border-emerald-800 bg-emerald-800 text-white"
                            : "border-emerald-700 bg-white text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
                      }`}
                    >
                      {index + 1}
                    </button>
                  );
                })}
                <span className="w-5 shrink-0 text-center text-xs font-semibold text-gray-500">
                  {row}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-gray-600">
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-t border border-emerald-700 bg-white"
              />
              Wolne
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-t border border-gray-300 bg-gray-200"
              />
              Zajęte
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-t border border-emerald-800 bg-emerald-800"
              />
              Wybrane
            </span>
          </div>
        </section>

        <aside aria-live="polite" className="min-w-0">
          {selectedSeat ? (
            <ReservationForm
              eventId={eventId}
              seatId={selectedSeat}
              onSeatTaken={() => setRefreshKey((key) => key + 1)}
            />
          ) : (
            <div className="border-t border-gray-200 pt-4 text-sm text-gray-600 lg:border-t-0 lg:border-l lg:pl-5 lg:pt-0">
              Wybierz wolne miejsce, aby przejść do rezerwacji.
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
