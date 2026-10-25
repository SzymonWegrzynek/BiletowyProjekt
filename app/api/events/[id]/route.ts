import { eventsCollection, reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { activeReservationFilter } from "@/lib/reservation";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id.trim()) return apiError("NOT_FOUND", "Nie ma takiego spektaklu");

  const event = await eventsCollection().findOne(
    { _id: id },
    { projection: { _id: 1, title: 1, date: 1, time: 1, stage: 1 } },
  );
  if (!event) return apiError("NOT_FOUND", "Nie ma takiego spektaklu");

  const now = new Date();
  const taken = await reservationsCollection()
    .find(
      { eventId: id, ...activeReservationFilter(now) },
      { projection: { _id: 0, seatId: 1 } },
    )
    .toArray();

  return Response.json({ event, takenSeats: taken.map((r) => r.seatId) });
}
