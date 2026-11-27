import { ObjectId } from "mongodb";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { formatSeat } from "@/lib/format";
import { reservationIdSchema } from "@/lib/schemas";
import {
  CHECKOUT_SESSION_TTL_MS,
  PAYMENT_RETRY_AFTER_SECONDS,
  expireCheckoutSessionQuietly,
  getAppUrl,
  getStripe,
  isPaymentUnavailable,
} from "@/lib/stripe";

function paymentUnavailable(): Response {
  return apiError("PAYMENT_UNAVAILABLE", undefined, {
    "Retry-After": String(PAYMENT_RETRY_AFTER_SECONDS),
  });
}

// POST /api/reservations/:id/checkout → 200 { url } strony płatności Stripe'a.
// Sam endpoint niczego nie oznacza jako opłacone — to robi wyłącznie webhook.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = reservationIdSchema.safeParse(id);
  if (!parsed.success) {
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  }

  const _id = new ObjectId(parsed.data);
  const now = new Date();
  const reservations = reservationsCollection();

  // Odczyt tylko po to, żeby zbudować sesję i dać czytelną odmowę.
  // Nic tu nie zmieniamy, więc nie ma wyścigu „sprawdź, potem zapisz”.
  const reservation = await reservations.findOne(
    { _id },
    {
      projection: {
        eventId: 1,
        seatId: 1,
        email: 1,
        status: 1,
        expiresAt: 1,
        amount: 1,
      },
    },
  );
  if (!reservation) return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  if (reservation.status === "purchased") return apiError("ALREADY_PAID");
  if (reservation.expiresAt <= now) return apiError("RESERVATION_EXPIRED");

  // Kwota wyłącznie z bazy — nigdy z requestu ani z aktualnej ceny spektaklu.
  const amount = reservation.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    console.error(`Rezerwacja ${parsed.data} nie ma poprawnego amount`);
    return paymentUnavailable();
  }

  const event = await eventsCollection().findOne(
    { _id: reservation.eventId },
    { projection: { title: 1, date: 1, time: 1, stage: 1 } },
  );

  let session;
  try {
    const appUrl = getAppUrl();
    session = await getStripe().checkout.sessions.create({
      mode: "payment",
      locale: "pl",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "pln",
            unit_amount: amount,
            product_data: {
              name: `${event?.title ?? "Bilet"} — ${formatSeat(reservation.seatId)}`,
              ...(event
                ? {
                    description: `${event.date}, ${event.time}, ${event.stage}`,
                  }
                : {}),
            },
          },
        },
      ],
      client_reference_id: parsed.data,
      metadata: { reservationId: parsed.data },
      payment_intent_data: { metadata: { reservationId: parsed.data } },
      customer_email: reservation.email,
      success_url: `${appUrl}/rezerwacja/${parsed.data}/platnosc`,
      cancel_url: `${appUrl}/rezerwacja/${parsed.data}?anulowano=1`,
      expires_at: Math.floor((now.getTime() + CHECKOUT_SESSION_TTL_MS) / 1000),
    });
  } catch (error) {
    if (isPaymentUnavailable(error)) {
      // Rezerwacja zostaje "held", licznik leci dalej — klient może ponowić.
      console.error("Stripe niedostępny przy tworzeniu sesji Checkout", error);
      return paymentUnavailable();
    }
    throw error;
  }

  if (!session.url) {
    console.error(`Sesja Stripe ${session.id} bez url`);
    return paymentUnavailable();
  }

  // Zapisujemy id sesji jednym warunkowym zapisem — tylko gdy rezerwacja
  // wciąż czeka na płatność. Dostajemy poprzednią sesję, żeby ją wygasić:
  // dwa kliknięcia / dwie karty przeglądarki nie zostawią dwóch aktywnych
  // sesji do opłacenia (zagrożenie „podwójna płatność”).
  const before = await reservations.findOneAndUpdate(
    { _id, status: "held" },
    { $set: { checkoutSessionId: session.id } },
    { returnDocument: "before", projection: { checkoutSessionId: 1 } },
  );

  if (!before) {
    // W międzyczasie rezerwacja została opłacona albo zniknęła — nowa sesja
    // jest zbędna i nie może zostać opłacona.
    await expireCheckoutSessionQuietly(session.id);
    const current = await reservations.findOne(
      { _id },
      { projection: { status: 1 } },
    );
    if (current?.status === "purchased") return apiError("ALREADY_PAID");
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  }

  if (before.checkoutSessionId && before.checkoutSessionId !== session.id) {
    await expireCheckoutSessionQuietly(before.checkoutSessionId);
  }

  return Response.json({ url: session.url }, { status: 200 });
}
