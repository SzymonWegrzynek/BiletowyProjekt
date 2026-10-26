"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { eventSchema, type Event } from "@/lib/schemas";

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
  const [events, setEvents] = useState<Event[]>([]);
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
        const parsed = eventSchema.array().safeParse(body);
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
    <ul className="divide-y divide-gray-200 border-y border-gray-200">
      {events.map((event) => (
        <li key={event._id}>
          <Link
            href={`/spektakl/${encodeURIComponent(event._id)}`}
            className="group grid gap-3 py-5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-800 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8 sm:py-6"
          >
            <span className="min-w-0">
              <span className="block text-xl font-semibold text-gray-950 group-hover:text-emerald-800 sm:text-2xl">
                {event.title}
              </span>
              <span className="mt-1 block text-sm text-gray-600">
                {event.stage}
              </span>
            </span>
            <span className="flex items-baseline gap-3 text-sm text-gray-700 sm:justify-end">
              <span>{formatDate(event.date)}</span>
              <span className="font-mono font-semibold tabular-nums text-gray-950">
                {event.time}
              </span>
              <span aria-hidden="true" className="ml-1 text-emerald-800">
                →
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
