import { ObjectId } from "mongodb";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/Breadcrumb";
import { PaymentStatus } from "@/components/PaymentStatus";
import { reservationsCollection } from "@/lib/db";
import { reservationIdSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Płatność w toku" };

export default async function PaymentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!reservationIdSchema.safeParse(id).success) notFound();
  // Tylko cel linku do widowni. Stan płatności pochodzi wyłącznie z API.
  const reservation = await reservationsCollection().findOne(
    { _id: new ObjectId(id) },
    { projection: { _id: 0, eventId: 1 } },
  );
  return (
    <main className="mx-auto w-full max-w-4xl px-4 sm:px-6">
      <div className="pt-4">
        {/* Bez linku do rezerwacji — stamtąd łatwo zapłacić drugi raz. */}
        <Breadcrumb href="/" back="Repertuar" current="Płatność" />
      </div>
      <section className="card mt-8 px-6 py-12 sm:px-10">
        <PaymentStatus
          key={id}
          reservationId={id}
          eventId={reservation?.eventId ?? null}
        />
      </section>
    </main>
  );
}
