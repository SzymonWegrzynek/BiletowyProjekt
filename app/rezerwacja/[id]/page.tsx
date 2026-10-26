import { ObjectId } from "mongodb";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PurchaseTicketButton } from "@/components/PurchaseTicketButton";
import { ReservationTimer } from "@/components/ReservationTimer";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { formatSeat } from "@/lib/format";
import { reservationIdSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rezerwacja" };

export default function ReservationPage({
  params,
}: PageProps<"/rezerwacja/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Twoja rezerwacja</h1>
      {/* cacheComponents: odczyt z bazy musi być za granicą Suspense. */}
      <Suspense fallback={<p>Wczytuję rezerwację…</p>}>
        <ReservationDetails params={params} />
      </Suspense>
    </main>
  );
}

async function ReservationDetails({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!reservationIdSchema.safeParse(id).success) notFound();

  // Do klienta trafiają tylko pola potrzebne na ekranie (bez imienia i e-maila).
  const reservation = await reservationsCollection().findOne(
    { _id: new ObjectId(id) },
    { projection: { eventId: 1, seatId: 1, status: 1, expiresAt: 1, code: 1 } },
  );
  if (!reservation) notFound();
  if (reservation.status === "purchased" && reservation.code) {
    redirect(`/bilet/${reservation.code}`);
  }

  const event = await eventsCollection().findOne({ _id: reservation.eventId });

  return (
    <section className="flex flex-col gap-4">
      <div>
        {event && (
          <>
            <p className="text-xl font-medium">{event.title}</p>
            <p className="text-gray-600">
              {event.date}, {event.time} · {event.stage}
            </p>
          </>
        )}
        <p className="mt-2 font-medium">{formatSeat(reservation.seatId)}</p>
      </div>

      <ReservationTimer
        expiresAt={reservation.expiresAt.toISOString()}
        eventId={reservation.eventId}
      >
        <PurchaseTicketButton reservationId={id} />
      </ReservationTimer>
    </section>
  );
}
