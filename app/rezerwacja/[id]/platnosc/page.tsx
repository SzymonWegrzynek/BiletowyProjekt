import { ObjectId } from "mongodb";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
      <PaymentStatus
        key={id}
        reservationId={id}
        eventId={reservation?.eventId ?? null}
      />
    </main>
  );
}
