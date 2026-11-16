"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEventDate, formatPrice } from "@/lib/format";
import { catalogEventSchema, type CatalogEvent } from "@/lib/schemas";

type CatalogState = "loading" | "ready" | "error";

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
      <div role="status" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <span className="sr-only">Wczytuję repertuar…</span>
        {[0, 1, 2].map((card) => (
          <div
            key={card}
            aria-hidden="true"
            className="card h-64 animate-pulse p-7"
          >
            <div className="h-3 w-24 rounded bg-line" />
            <div className="mt-5 h-10 w-2/3 rounded-lg bg-line" />
          </div>
        ))}
      </div>
    );
  }

  if (state === "error") {
    return (
      <section
        className="card flex flex-col items-start gap-5 p-7"
        aria-live="polite"
      >
        <p role="alert" className="text-ink">
          Nie udało się wczytać repertuaru.
        </p>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="btn-secondary"
        >
          Spróbuj ponownie
        </button>
      </section>
    );
  }

  if (events.length === 0) {
    return <p className="card p-7 text-muted">Brak spektakli</p>;
  }

  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {events.map((event) => {
        const date = formatEventDate(event.date);
        return (
          <li key={event._id}>
            <Link
              href={`/spektakl/${encodeURIComponent(event._id)}`}
              className="card group flex h-full flex-col p-7 transition duration-300 hover:-translate-y-0.5 hover:border-gold/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <span className="label">{event.stage}</span>
              <span className="title mt-3 text-5xl leading-none">
                {event.title}
              </span>

              <dl className="mt-10 mb-8 grid grid-cols-2 gap-4">
                <div>
                  <dt className="label text-muted">Data</dt>
                  <dd className="mt-1 text-ink">
                    {date ? `${date.day} ${date.month}` : event.date}
                  </dd>
                  {date && (
                    <dd className="text-sm text-muted">{date.weekday}</dd>
                  )}
                </div>
                <div>
                  <dt className="label text-muted">Godzina</dt>
                  <dd className="mt-1 text-ink numerals">{event.time}</dd>
                </div>
              </dl>

              <span className="mt-auto flex items-center justify-between gap-4 border-t border-line/60 pt-5 text-sm font-medium text-gold">
                <span className="numerals text-base text-ink">
                  {event.price === undefined
                    ? "Cena niedostępna"
                    : formatPrice(event.price)}
                </span>
                <span className="flex items-center gap-2">
                  Wybierz miejsce
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="size-5 transition-transform duration-300 group-hover:translate-x-1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M5 12h14m-6-6 6 6-6 6" />
                  </svg>
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
