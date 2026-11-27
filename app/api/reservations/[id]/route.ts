import { ObjectId } from "mongodb";
import { reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { reservationIdSchema, type ReservationApiStatus } from "@/lib/schemas";

// Front odpytuje co 2 s po powrocie ze Stripe'a — żadnego cache po drodze.
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/reservations/:id → { status, amount, expiresAt, pointsUsed, code?,
// pointsEarned?, cardAmount? } — pola punktów z Etapu III tylko dopisujemy.
// Bez imienia i e-maila: id rezerwacji jest w URL, więc odpowiedź nie może
// ujawniać danych klienta.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = reservationIdSchema.safeParse(id);
  if (!parsed.success) {
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji", NO_STORE);
  }

  let reservation;
  try {
    reservation = await reservationsCollection().findOne(
      { _id: new ObjectId(parsed.data) },
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
  } catch (error) {
    // Szczegóły awarii tylko w logach; front ponowi odczyt.
    console.error(`Odczyt rezerwacji ${parsed.data} nie powiódł się`, error);
    return apiError("RESERVATION_UNAVAILABLE", undefined, NO_STORE);
  }
  if (!reservation) {
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji", NO_STORE);
  }

  // Ważność liczy serwer, nie przeglądarka.
  const now = new Date();
  const status: ReservationApiStatus =
    reservation.status === "purchased"
      ? "paid"
      : reservation.expiresAt > now
        ? "held"
        : "expired";

  return Response.json(
    {
      status,
      // Starsze rezerwacje bez kwoty: null, nie dzisiejsza cena spektaklu.
      amount: reservation.amount ?? null,
      expiresAt: reservation.expiresAt.toISOString(),
      // Rozliczenie punktów utrwala webhook przy opłaceniu; wcześniej 0.
      pointsUsed: status === "paid" ? (reservation.pointsUsed ?? 0) : 0,
      // Kod biletu i nagroda tylko przy opłaconej rezerwacji — zdobyte
      // punkty przed potwierdzeniem zakupu nie są rozliczeniem.
      ...(status === "paid" && reservation.code
        ? {
            code: reservation.code,
            ...(reservation.pointsEarned !== undefined
              ? { pointsEarned: reservation.pointsEarned }
              : {}),
            ...(reservation.cardAmount !== undefined
              ? { cardAmount: reservation.cardAmount }
              : {}),
          }
        : {}),
    },
    { headers: NO_STORE },
  );
}
