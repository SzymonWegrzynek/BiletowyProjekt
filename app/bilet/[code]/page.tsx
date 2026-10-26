import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eventsCollection, reservationsCollection } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Bilet",
};

export default async function TicketPage({
  params,
}: PageProps<"/bilet/[code]">) {
  const { code } = await params;

  const reservation = await reservationsCollection().findOne(
    { code },
    { projection: { _id: 0, eventId: 1, seatId: 1, status: 1, code: 1 } },
  );

  if (!reservation || reservation.status !== "purchased" || !reservation.code) {
    notFound();
  }

  const event = await eventsCollection().findOne(
    { _id: reservation.eventId },
    { projection: { _id: 1, title: 1, date: 1, time: 1, stage: 1 } },
  );

  if (!event) notFound();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/" className="text-sm font-medium text-gray-700 underline">
        Wróć do repertuaru
      </Link>

      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-800">
          Bilet kupiony
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-gray-950">{event.title}</h1>
        <p className="mt-2 text-gray-700">
          {event.date}, {event.time} · {event.stage}
        </p>

        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <dt className="text-sm text-gray-500">Miejsce</dt>
            <dd className="mt-1 text-xl font-semibold text-gray-900">
              {reservation.seatId}
            </dd>
          </div>
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <dt className="text-sm text-gray-500">Kod biletu</dt>
            <dd className="mt-1 font-mono text-xl font-semibold text-gray-900">
              {reservation.code}
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
