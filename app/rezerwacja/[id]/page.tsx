import { ObjectId } from "mongodb";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { CheckoutButton } from "@/components/CheckoutButton";
import { ReservationTimer } from "@/components/ReservationTimer";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { formatEventDate, formatPrice, formatSeat } from "@/lib/format";
import { reservationIdSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rezerwacja" };

export default function ReservationPage({
  params,
  searchParams,
}: PageProps<"/rezerwacja/[id]">) {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 sm:px-6">
      {/* Odczyt z bazy za granicą Suspense — szkielet strony jest od razu. */}
      <Suspense
        fallback={
          <p role="status" className="py-24 text-center text-muted">
            Wczytuję rezerwację…
          </p>
        }
      >
        <ReservationDetails params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function ReservationDetails({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  // Powrót z cancel_url Stripe'a: tylko komunikat, status i czas się nie zmieniają.
  const cancelled = (await searchParams).anulowano === "1";
  if (!reservationIdSchema.safeParse(id).success) notFound();

  // Do klienta trafiają tylko pola potrzebne na ekranie (bez imienia i e-maila).
  const reservation = await reservationsCollection().findOne(
    { _id: new ObjectId(id) },
    {
      projection: {
        eventId: 1,
        seatId: 1,
        status: 1,
        expiresAt: 1,
        code: 1,
        amount: 1,
        // E-mail służy tylko do odczytu salda punktów; nie trafia do URL.
        email: 1,
      },
    },
  );
  if (!reservation) notFound();
  if (reservation.status === "purchased" && reservation.code) {
    redirect(`/bilet/${reservation.code}`);
  }

  const event = await eventsCollection().findOne({ _id: reservation.eventId });
  // Kwota z rezerwacji (kopia ceny z chwili rezerwacji), nie aktualna cena
  // spektaklu. Starsze rezerwacje Etapu I mogą jej nie mieć.
  const amount =
    typeof reservation.amount === "number" &&
    Number.isSafeInteger(reservation.amount) &&
    reservation.amount >= 0
      ? reservation.amount
      : null;

  const date = event ? formatEventDate(event.date) : null;
  const title = event?.title ?? "Spektakl";

  return (
    <>
      <div className="pt-4">
        <Breadcrumb
          href={`/spektakl/${encodeURIComponent(reservation.eventId)}`}
          back="Widownia"
          current="Rezerwacja"
        />
      </div>

      <header className="pt-8 pb-8">
        <p className="label">Twoja rezerwacja</p>
        <h1 className="title mt-3 text-6xl sm:text-7xl">{title}</h1>
      </header>

      <div className="grid gap-5 md:grid-cols-[15rem_minmax(0,1fr)] md:items-start">
        <section className="card px-6 py-10 sm:px-10 md:order-2">
          <ReservationTimer
            expiresAt={reservation.expiresAt.toISOString()}
            eventId={reservation.eventId}
          >
            {amount !== null ? (
              <CheckoutButton
                key={`${id}:${reservation.email}`}
                email={reservation.email}
                amount={amount}
                cancelled={cancelled}
                reservationId={id}
                eventId={reservation.eventId}
                expiresAt={reservation.expiresAt.toISOString()}
              />
            ) : (
              <p role="status" className="alert">
                Nie udało się ustalić kwoty rezerwacji. Płatność jest chwilowo
                niedostępna.
              </p>
            )}
          </ReservationTimer>
        </section>

        <aside className="card p-7 md:order-1">
          <h2 className="title text-xl">Szczegóły</h2>
          <dl className="mt-5 grid grid-cols-2 gap-5 md:grid-cols-1">
            <div>
              <dt className="label text-muted">Miejsce</dt>
              <dd className="mt-1 text-ink">
                {formatSeat(reservation.seatId)}
              </dd>
            </div>
            {amount !== null && (
              <div>
                <dt className="label text-muted">Cena biletu</dt>
                <dd className="mt-1 text-ink numerals">
                  {formatPrice(amount)}
                </dd>
              </div>
            )}
            {event && (
              <>
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
                <div>
                  <dt className="label text-muted">Scena</dt>
                  <dd className="mt-1 text-ink">{event.stage}</dd>
                </div>
              </>
            )}
          </dl>
        </aside>
      </div>
    </>
  );
}
