import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { formatSeat } from "@/lib/format";

export const metadata: Metadata = { title: "Twój bilet" };

export default function TicketPage({ params }: PageProps<"/bilet/[code]">) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Twój bilet</h1>
      <Suspense fallback={<p role="status">Wczytuję bilet…</p>}>
        <TicketDetails params={params} />
      </Suspense>
    </main>
  );
}

async function TicketDetails({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const reservation = await reservationsCollection().findOne(
    { code, status: "purchased" },
    { projection: { eventId: 1, seatId: 1, code: 1 } },
  );
  if (!reservation || !reservation.code) notFound();

  const event = await eventsCollection().findOne(
    { _id: reservation.eventId },
    { projection: { title: 1, date: 1, time: 1, stage: 1 } },
  );
  if (!event) notFound();

  return (
    <section className="flex flex-col gap-6 border-y border-gray-300 py-6">
      <header>
        <h2 className="text-2xl font-semibold">{event.title}</h2>
        <p className="mt-2 text-gray-600">
          {event.date} · {event.time} · {event.stage}
        </p>
      </header>

      <p className="text-lg font-medium">{formatSeat(reservation.seatId)}</p>

      <div className="border-t border-gray-200 pt-4">
        <p className="text-sm font-medium uppercase tracking-wider text-gray-500">
          Kod biletu
        </p>
        <p className="mt-2 break-all font-mono text-3xl font-bold tracking-widest text-emerald-900">
          {reservation.code}
        </p>
      </div>
    </section>
  );
}
