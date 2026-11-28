import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/Breadcrumb";
import { SeatMap } from "@/components/SeatMap";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { activeReservationFilter } from "@/lib/reservation";
import { eventSeats } from "@/lib/waitlist";

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
    {
      projection: {
        _id: 1,
        title: 1,
        date: 1,
        time: 1,
        stage: 1,
        price: 1,
        seats: 1,
      },
    },
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
    <main className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <div className="pt-4">
        <Breadcrumb href="/" back="Repertuar" current={event.title} />
      </div>

      <header className="pt-8 pb-8">
        <p className="label">{event.stage}</p>
        <h1 className="title mt-3 text-6xl sm:text-7xl">{event.title}</h1>
      </header>

      <SeatMap
        key={event._id}
        event={event}
        takenSeats={takenSeats}
        soldOut={eventSeats(event).every((seat) => takenSeats.includes(seat))}
      />
    </main>
  );
}
