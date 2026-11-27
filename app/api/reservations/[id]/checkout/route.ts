import { ObjectId } from "mongodb";
import { eventsCollection, reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { formatSeat } from "@/lib/format";
import {
  compensateAttempt,
  maxPointsFor,
  openAttempt,
  spendPointsForCheckout,
} from "@/lib/payment-attempts";
import { checkoutBodySchema, reservationIdSchema } from "@/lib/schemas";
import {
  CHECKOUT_SESSION_TTL_MS,
  PAYMENT_RETRY_AFTER_SECONDS,
  expireCheckoutSessionQuietly,
  getAppUrl,
  getStripe,
  isPaymentUnavailable,
} from "@/lib/stripe";
import { LOYALTY_RETRY_AFTER_SECONDS } from "@/lib/voucherify";

function paymentUnavailable(): Response {
  return apiError("PAYMENT_UNAVAILABLE", undefined, {
    "Retry-After": String(PAYMENT_RETRY_AFTER_SECONDS),
  });
}

// Body jest opcjonalne: brak body = zakup bez punktów (jak w Etapie II).
async function readBody(request: Request) {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return checkoutBodySchema.safeParse({});
  try {
    return checkoutBodySchema.safeParse(JSON.parse(text));
  } catch {
    return checkoutBodySchema.safeParse(null);
  }
}

// Punkty nie zostają na karcie po próbie, której sesji nikt nie opłaci.
// Błąd zwrotu nie psuje odpowiedzi — próba zostaje "returning" i dokończy ją
// ponowienie (webhook checkout.session.expired) albo pnpm loyalty:pending.
async function returnPointsQuietly(attemptId: string, reason: string) {
  try {
    await compensateAttempt(attemptId, reason);
  } catch (error) {
    console.error(`Nie oddano punktów próby ${attemptId} (${reason})`, error);
  }
}

// POST /api/reservations/:id/checkout → 200 { url } strony płatności Stripe'a.
// Body (opcjonalne): { points } — ile punktów wydać (1 punkt = 1 grosz,
// najwyżej połowa ceny). Sesja Stripe jest na amount - points.
// Sam endpoint niczego nie oznacza jako opłacone — to robi wyłącznie webhook.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = reservationIdSchema.safeParse(id);
  if (!parsed.success) {
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  }

  const body = await readBody(request);
  if (!body.success) {
    return apiError(
      "VALIDATION_ERROR",
      body.error.issues[0]?.message ?? "Niepoprawna liczba punktów",
    );
  }
  const points = body.data.points ?? 0;

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
        checkoutSessionId: 1,
        checkoutAttemptId: 1,
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

  const maxPoints = maxPointsFor(amount);
  if (points > maxPoints) {
    return apiError(
      "VALIDATION_ERROR",
      `Punktami możesz zapłacić najwyżej połowę ceny: ${maxPoints.toLocaleString("pl-PL")} pkt`,
    );
  }
  // Tyle pobierze Stripe. Kwota nadal wyłącznie z bazy.
  const cardAmount = amount - points;

  const event = await eventsCollection().findOne(
    { _id: reservation.eventId },
    { projection: { title: 1, date: 1, time: 1, stage: 1 } },
  );

  // Poprzednia próba z punktami (klient wrócił ze Stripe'a i płaci jeszcze
  // raz): najpierw wygaszamy jej sesję i oddajemy jej punkty, żeby mógł
  // wybrać inną liczbę bez blokowania salda przez porzuconą sesję. Punkty
  // wracają tylko, gdy Stripe potwierdził, że tamtej sesji nie da się opłacić.
  if (reservation.checkoutAttemptId && reservation.checkoutSessionId) {
    if (await expireCheckoutSessionQuietly(reservation.checkoutSessionId)) {
      await returnPointsQuietly(
        reservation.checkoutAttemptId,
        "session_replaced",
      );
    }
  }

  // Najpierw punkty, potem sesja: Stripe nie może pobrać mniej, niż wynika
  // z potwierdzonego potrącenia. Saldo sprawdza Voucherify, nie przeglądarka.
  let attemptId: string | undefined;
  if (points > 0) {
    const spent = await spendPointsForCheckout({
      reservationId: parsed.data,
      email: reservation.email.trim().toLowerCase(),
      points,
      amount,
    });
    if (!spent.ok) {
      if (spent.reason === "insufficient") {
        return apiError(
          "INSUFFICIENT_POINTS",
          spent.available === undefined
            ? undefined
            : `Masz za mało punktów: dostępne ${spent.available.toLocaleString("pl-PL")}. Wybierz mniej punktów.`,
        );
      }
      return apiError("LOYALTY_UNAVAILABLE", undefined, {
        "Retry-After": String(
          spent.retryAfterSeconds ?? LOYALTY_RETRY_AFTER_SECONDS,
        ),
      });
    }
    attemptId = spent.attemptId;
  }

  let session;
  try {
    const appUrl = getAppUrl();
    session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        locale: "pl",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "pln",
              unit_amount: cardAmount,
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
        metadata: {
          reservationId: parsed.data,
          // Webhook bierze liczbę punktów z próby w bazie, nie z metadata.
          ...(attemptId ? { attemptId, pointsUsed: String(points) } : {}),
        },
        payment_intent_data: { metadata: { reservationId: parsed.data } },
        customer_email: reservation.email,
        success_url: `${appUrl}/rezerwacja/${parsed.data}/platnosc`,
        cancel_url: `${appUrl}/rezerwacja/${parsed.data}?anulowano=1`,
        expires_at: Math.floor(
          (now.getTime() + CHECKOUT_SESSION_TTL_MS) / 1000,
        ),
      },
      ...(attemptId ? [{ idempotencyKey: `checkout-${attemptId}` }] : []),
    );
  } catch (error) {
    // Bez sesji nikt tej próby nie opłaci — punkty wracają.
    if (attemptId) await returnPointsQuietly(attemptId, "stripe_failed");
    if (isPaymentUnavailable(error)) {
      // Rezerwacja zostaje "held", licznik leci dalej — klient może ponowić.
      console.error("Stripe niedostępny przy tworzeniu sesji Checkout", error);
      return paymentUnavailable();
    }
    throw error;
  }

  if (!session.url) {
    console.error(`Sesja Stripe ${session.id} bez url`);
    if (attemptId && (await expireCheckoutSessionQuietly(session.id))) {
      await returnPointsQuietly(attemptId, "session_without_url");
    }
    return paymentUnavailable();
  }

  if (attemptId) await openAttempt(attemptId, session.id);

  // Zapisujemy id sesji jednym warunkowym zapisem — tylko gdy rezerwacja
  // wciąż czeka na płatność. Dostajemy poprzednią sesję, żeby ją wygasić:
  // dwa kliknięcia / dwie karty przeglądarki nie zostawią dwóch aktywnych
  // sesji do opłacenia (zagrożenie „podwójna płatność”).
  const before = await reservations.findOneAndUpdate(
    { _id, status: "held" },
    attemptId
      ? {
          $set: { checkoutSessionId: session.id, checkoutAttemptId: attemptId },
        }
      : {
          $set: { checkoutSessionId: session.id },
          $unset: { checkoutAttemptId: "" },
        },
    {
      returnDocument: "before",
      projection: { checkoutSessionId: 1, checkoutAttemptId: 1 },
    },
  );

  if (!before) {
    // W międzyczasie rezerwacja została opłacona albo zniknęła — nowa sesja
    // jest zbędna i nie może zostać opłacona.
    const expired = await expireCheckoutSessionQuietly(session.id);
    // Sesja nieopłacalna → punkty wracają. Gdy wygaszenie się nie udało,
    // ewentualną płatność obsłuży webhook (zwrot pieniędzy i punktów).
    if (attemptId && expired) {
      await returnPointsQuietly(attemptId, "reservation_closed");
    }
    const current = await reservations.findOne(
      { _id },
      { projection: { status: 1 } },
    );
    if (current?.status === "purchased") return apiError("ALREADY_PAID");
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  }

  if (before.checkoutSessionId && before.checkoutSessionId !== session.id) {
    const expired = await expireCheckoutSessionQuietly(
      before.checkoutSessionId,
    );
    // Poprzednia próba z punktami: punkty wracają dopiero, gdy Stripe
    // potwierdził, że jej sesji nie da się opłacić. Inaczej rozstrzygnie
    // webhook (completed → zwrot pieniędzy i punktów, expired → zwrot punktów).
    if (before.checkoutAttemptId && expired) {
      await returnPointsQuietly(before.checkoutAttemptId, "session_replaced");
    }
  }

  return Response.json({ url: session.url }, { status: 200 });
}
