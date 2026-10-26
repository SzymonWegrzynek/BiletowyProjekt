import { MongoServerError, ObjectId } from "mongodb";
import { eventsCollection, getClient, reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { clientIp, takeReservationSlot } from "@/lib/rate-limit";
import { reservationExpiresAt } from "@/lib/reservation";
import { createReservationSchema, type Reservation } from "@/lib/schemas";

const DUPLICATE_KEY = 11000;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createReservationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message);
  }

  // Limit po walidacji (ta nie dotyka bazy), a przed jakimkolwiek zapytaniem
  // o spektakl czy miejsce — nadmiar ruchu odpada najtaniej, jak się da.
  const now = new Date();
  const retryAfter = await takeReservationSlot(clientIp(request), now);
  if (retryAfter !== null) {
    return apiError("RATE_LIMITED", undefined, {
      "Retry-After": String(retryAfter),
    });
  }

  const { eventId, seatId } = parsed.data;
  const event = await eventsCollection().findOne(
    { _id: eventId },
    { projection: { _id: 1 } },
  );
  if (!event) return apiError("NOT_FOUND", "Nie ma takiego spektaklu");

  const reservation: Reservation = {
    _id: new ObjectId(),
    ...parsed.data,
    status: "held",
    expiresAt: reservationExpiresAt(now),
    createdAt: now,
  };

  // Nie sprawdzamy "czy wolne" przed zapisem — konflikt rozstrzyga unikalny
  // indeks { eventId, seatId }. Wygasłe "held" usuwamy w tej samej transakcji,
  // żeby nie blokowało indeksu; kupione zostaje na zawsze.
  const reservations = reservationsCollection();
  try {
    await getClient().withSession((session) =>
      session.withTransaction(async () => {
        await reservations.deleteOne(
          { eventId, seatId, status: "held", expiresAt: { $lte: now } },
          { session },
        );
        await reservations.insertOne(reservation, { session });
      }),
    );
  } catch (error) {
    if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
      // Miejsce już zajęte — ale jeśli to ten sam klient ponawia tę samą
      // rezerwację (podwójny klik, retry po timeoucie), oddajemy mu ją zamiast
      // 409. Zapis już rozstrzygnął indeks, to tylko odczyt zwycięzcy.
      const same = await reservations.findOne(
        {
          eventId,
          seatId,
          customerName: parsed.data.customerName,
          email: parsed.data.email,
          status: "held",
          expiresAt: { $gt: now },
        },
        { projection: { expiresAt: 1 } },
      );
      if (same) {
        return Response.json(
          {
            reservationId: same._id.toHexString(),
            expiresAt: same.expiresAt.toISOString(),
          },
          { status: 200 },
        );
      }
      return apiError("SEAT_TAKEN");
    }
    throw error;
  }

  return Response.json(
    {
      reservationId: reservation._id.toHexString(),
      expiresAt: reservation.expiresAt.toISOString(),
    },
    { status: 201 },
  );
}
