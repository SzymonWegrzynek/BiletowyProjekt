import { ObjectId } from "mongodb";
import { reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { reservationIdSchema } from "@/lib/schemas";
import { reservationSummary } from "@/lib/reservation-summary";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const headers = { "Cache-Control": "no-store" };
  if (!reservationIdSchema.safeParse(id).success)
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji", headers);
  try {
    const reservation = await reservationsCollection().findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          status: 1,
          amount: 1,
          expiresAt: 1,
          code: 1,
          pointsUsed: 1,
          pointsEarned: 1,
          cardAmount: 1,
        },
      },
    );
    if (!reservation)
      return apiError("NOT_FOUND", "Nie ma takiej rezerwacji", headers);
    return Response.json(reservationSummary(reservation), { headers });
  } catch {
    return apiError("RESERVATION_UNAVAILABLE", undefined, headers);
  }
}
