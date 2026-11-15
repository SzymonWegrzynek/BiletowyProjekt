"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { catalogEventSchema, type CatalogEvent } from "@/lib/schemas";
import { formatPrice } from "@/lib/format";

type CatalogState = "loading" | "ready" | "error";

function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;

  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function EventCatalog() {
  const [events, setEvents] = useState<CatalogEvent[]>([]);
  const [state, setState] = useState<CatalogState>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function loadEvents() {
      setState("loading");
      try {
        const response = await fetch("/api/events", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Event request failed");

        const body: unknown = await response.json();
        const parsed = catalogEventSchema.array().safeParse(body);
        if (!parsed.success) throw new Error("Invalid event response");

        setEvents(parsed.data);
        setState("ready");
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    }

    void loadEvents();
    return () => controller.abort();
  }, [attempt]);

  if (state === "loading") {
    return (
      <p role="status" className="py-4 text-gray-600">
        Wczytuję repertuar…
      </p>
    );
  }

  if (state === "error") {
    return (
      <section
        className="flex flex-col items-start gap-4 py-4"
        aria-live="polite"
      >
        <p role="alert" className="text-red-700">
          Nie udało się wczytać repertuaru.
        </p>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="rounded border border-gray-400 px-4 py-2 font-medium text-gray-900 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
        >
          Spróbuj ponownie
        </button>
      </section>
    );
  }

  if (events.length === 0) {
    return <p className="py-4 text-gray-600">Brak spektakli</p>;
  }

  return (
    <ul className="event-grid">
      {events.map((event, index) => (
        <li key={event._id}>
          <Link
            href={`/spektakl/${encodeURIComponent(event._id)}`}
            className="event-card"
            data-tone={index % 3}
          >
            <div className="event-poster" aria-hidden="true">
              <span className="poster-index">
                SCENA / {String(index + 1).padStart(2, "0")}
              </span>
              <span className="poster-star">✳</span>
              <span className="poster-title">{event.title}</span>
            </div>
            <div className="event-info">
              <span className="event-stage">{event.stage}</span>
              <h3 className="event-title">{event.title}</h3>
              <div className="event-date">
                <span>{formatDate(event.date)}</span>
                <span aria-hidden="true">·</span>
                <span>{event.time}</span>
              </div>
              <div className="event-bottom">
                <span className="event-price">
                  {event.price === undefined
                    ? "Cena niedostępna"
                    : formatPrice(event.price)}
                </span>
                <span className="event-action">
                  Wybierz miejsce <span aria-hidden="true">↗</span>
                </span>
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
