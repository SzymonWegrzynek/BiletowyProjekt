import { ObjectId } from "mongodb";
import { apiError } from "@/lib/errors";
import { reservationExpiresAt } from "@/lib/reservation";
import { createReservationSchema } from "@/lib/schemas";
import { STUB_EVENTS, STUB_TAKEN_SEATS } from "@/lib/stubs";

// TODO(karta B): transakcja + unikalny indeks, E11000 → SEAT_TAKEN.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createReservationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message);
  }

  const { eventId, seatId } = parsed.data;
  if (!STUB_EVENTS.some((e) => e._id === eventId)) {
    return apiError("NOT_FOUND", "Nie ma takiego spektaklu");
  }
  if (STUB_TAKEN_SEATS.includes(seatId)) return apiError("SEAT_TAKEN");

  return Response.json(
    {
      reservationId: new ObjectId().toHexString(),
      expiresAt: reservationExpiresAt(new Date()).toISOString(),
    },
    { status: 201 },
  );
}
