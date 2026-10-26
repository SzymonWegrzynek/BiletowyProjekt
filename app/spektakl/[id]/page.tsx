import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SeatMap } from "@/components/SeatMap";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { activeReservationFilter } from "@/lib/reservation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Widownia",
};

export default async function EventDetailsPage({
  params,
}: PageProps<"/spektakl/[id]">) {
  const { id } = await params;

  const event = await eventsCollection().findOne(
    { _id: id },
    { projection: { _id: 1, title: 1, date: 1, time: 1, stage: 1 } },
  );

  if (!event) notFound();

  const now = new Date();
  const takenSeats = await reservationsCollection()
    .find(
      { eventId: id, ...activeReservationFilter(now) },
      { projection: { _id: 0, seatId: 1 } },
    )
    .map((reservation) => reservation.seatId)
    .toArray();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex items-center justify-between gap-3 border-b border-gray-300 pb-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-emerald-800">
            Spektakl
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-gray-950">
            {event.title}
          </h1>
          <p className="mt-2 text-gray-600">
            {event.date}, {event.time} · {event.stage}
          </p>
        </div>

        <Link href="/" className="text-sm font-medium text-gray-700 underline">
          Wróć do repertuaru
        </Link>
      </div>

      <SeatMap eventId={event._id} takenSeats={takenSeats} />
    </main>
  );
}
