import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { emailStatusMessage } from "@/lib/email-state";
import { formatEventDate, formatSeat } from "@/lib/format";
import { settlementRows } from "@/lib/reservation-summary";

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
    {
      projection: {
        _id: 0,
        eventId: 1,
        seatId: 1,
        status: 1,
        code: 1,
        // Etap III: rozliczenie z utrwalonych pól rezerwacji (jak w mailu).
        amount: 1,
        cardAmount: 1,
        pointsUsed: 1,
        pointsEarned: 1,
        "confirmationEmail.status": 1,
        "confirmationEmail.deliveryStatus": 1,
      },
    },
  );

  // Bilet pokazujemy wyłącznie dla kupionej rezerwacji z kodem z bazy.
  if (!reservation || reservation.status !== "purchased" || !reservation.code) {
    notFound();
  }

  const event = await eventsCollection().findOne(
    { _id: reservation.eventId },
    { projection: { _id: 1, title: 1, date: 1, time: 1, stage: 1 } },
  );

  if (!event) notFound();

  const date = formatEventDate(event.date);
  // Te same etykiety i formatowanie co w mailu z biletem.
  const settlement = settlementRows(reservation);

  return (
    <main className="mx-auto w-full max-w-md px-4 pt-6 sm:pt-12">
      <p className="label flex items-center justify-center gap-2">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        Bilet kupiony
      </p>

      <article className="card mt-6 overflow-hidden">
        <header className="px-7 pt-9 pb-7">
          <p className="label">Bilet wstępu</p>
          <h1 className="title mt-3 text-5xl leading-none">{event.title}</h1>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 px-7 pb-9">
          <TicketFact
            label="Data"
            value={date ? `${date.day} ${date.month} ${date.year}` : event.date}
            hint={date?.weekday}
          />
          <TicketFact label="Godzina" value={event.time} numeric />
          <TicketFact label="Scena" value={event.stage} />
          <TicketFact label="Miejsce" value={formatSeat(reservation.seatId)} />
        </dl>

        {/* Perforacja między częściami biletu. */}
        <div aria-hidden="true" className="relative">
          <div className="mx-7 border-t border-dashed border-line" />
          <span className="absolute top-1/2 -left-3 size-6 -translate-y-1/2 rounded-full bg-paper" />
          <span className="absolute top-1/2 -right-3 size-6 -translate-y-1/2 rounded-full bg-paper" />
        </div>

        <div className="px-7 pt-7 pb-9 text-center">
          <p className="label text-muted">Kod biletu</p>
          <p className="mt-3 font-mono text-3xl font-semibold tracking-[0.18em] break-all text-gold">
            {reservation.code}
          </p>
          <p className="mt-3 text-sm text-muted">
            Pokaż ten kod przy wejściu na widownię.
          </p>
        </div>
      </article>

      <section aria-labelledby="settlement-heading" className="card mt-6 p-7">
        <h2 id="settlement-heading" className="label">
          Rozliczenie zakupu
        </h2>
        {settlement ? (
          <dl className="mt-4 grid grid-cols-3 gap-4">
            {settlement.map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="numerals mt-1 text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="status" className="mt-3 text-sm text-muted">
            Pełne rozliczenie zakupu jest jeszcze niedostępne. Dane biletu
            pozostają ważne.
          </p>
        )}
        <h2 id="email-heading" className="label mt-6">
          Potwierdzenie e-mail
        </h2>
        <p role="status" className="mt-2 text-sm text-muted">
          {emailStatusMessage(reservation.confirmationEmail)}
        </p>
      </section>

      <div className="mt-8 text-center">
        <Link href="/" className="btn-secondary">
          Wróć do repertuaru
        </Link>
      </div>
    </main>
  );
}

function TicketFact({
  label,
  value,
  hint,
  numeric = false,
}: {
  label: string;
  value: string;
  hint?: string;
  numeric?: boolean;
}) {
  return (
    <div>
      <dt className="label text-muted">{label}</dt>
      <dd className={`mt-1 text-ink ${numeric ? "numerals" : ""}`}>{value}</dd>
      {hint && <dd className="text-sm text-muted">{hint}</dd>}
    </div>
  );
}
