import { MongoServerError, ObjectId } from "mongodb";
import type Stripe from "stripe";
import { reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { reservationIdSchema } from "@/lib/schemas";
import {
  PAYMENT_RETRY_AFTER_SECONDS,
  PaymentConfigError,
  constructWebhookEvent,
  isSignatureError,
} from "@/lib/stripe";
import { generateTicketCode } from "@/lib/ticket";

const DUPLICATE_KEY = 11000;
const MAX_CODE_ATTEMPTS = 3;

// 2xx = „przyjęte, nie ponawiaj”. Inny status = Stripe ponowi zdarzenie.
const received = () => Response.json({ received: true });

// POST /api/webhooks/stripe — jedyne miejsce (poza starym /purchase), które
// oznacza rezerwację jako opłaconą. Ponowienia i równoległe dostarczenia
// tego samego zdarzenia dają jeden bilet z jednym kodem.
export async function POST(request: Request) {
  // Podpis liczy się z surowego body — nie wolno go parsować przed weryfikacją.
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return apiError("VALIDATION_ERROR", "Brak podpisu webhooka");
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(body, signature);
  } catch (error) {
    if (isSignatureError(error)) {
      return apiError("VALIDATION_ERROR", "Niepoprawny podpis webhooka");
    }
    if (error instanceof PaymentConfigError) {
      // Nasza konfiguracja, nie wina Stripe'a — 503, więc Stripe ponowi.
      console.error("Webhook Stripe bez konfiguracji", error);
      return apiError("PAYMENT_UNAVAILABLE", undefined, {
        "Retry-After": String(PAYMENT_RETRY_AFTER_SECONDS),
      });
    }
    throw error;
  }

  // Inne zdarzenia nas nie interesują — 200, żeby Stripe ich nie ponawiał.
  if (event.type !== "checkout.session.completed") return received();
  const session = event.data.object;
  if (session.payment_status !== "paid") return received();

  try {
    await handlePaidSession(session);
  } catch (error) {
    // Błąd bazy albo zwrotu: 500, żeby Stripe ponowił. Nigdy 200 bez
    // biletu albo zwrotu — klient by zapłacił za nic.
    console.error(`Webhook Stripe: nie obsłużono sesji ${session.id}`, error);
    return new Response("Nie udało się obsłużyć webhooka", { status: 500 });
  }
  return received();
}

async function handlePaidSession(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const parsed = reservationIdSchema.safeParse(
    session.client_reference_id ?? session.metadata?.reservationId,
  );
  if (!parsed.success) {
    console.error(`Webhook Stripe: sesja ${session.id} bez id rezerwacji`);
    return;
  }

  const reservationId = parsed.data;
  const _id = new ObjectId(reservationId);
  const reservations = reservationsCollection();
  const paidAt = new Date();

  // Jeden warunkowy zapis, jak zakup w Etapie I.
  // Drugi raz filtr już nie pasuje — ponowiony webhook niczego nie zmienia.
  // E11000 może tu dać tylko kolizja kodu → losujemy nowy.
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    try {
      const updated = await reservations.findOneAndUpdate(
        { _id, status: "held" },
        {
          $set: {
            status: "purchased",
            code: generateTicketCode(),
            paidAt,
            paidSessionId: session.id,
          },
        },
        { returnDocument: "after", projection: { _id: 1 } },
      );
      if (updated) return;
      break;
    } catch (error) {
      const codeCollision =
        error instanceof MongoServerError && error.code === DUPLICATE_KEY;
      if (!codeCollision || attempt === MAX_CODE_ATTEMPTS) throw error;
    }
  }

  // Zapis nic nie zmienił — odczyt tylko po to, żeby wybrać gałąź.
  // Status "purchased" nie wraca do "held", więc tu nie ma wyścigu.
  const existing = await reservations.findOne(
    { _id },
    { projection: { status: 1, paidSessionId: 1 } },
  );

  // Ta sama sesja drugi raz (ponowienie Stripe'a) — bilet już jest.
  if (existing?.status === "purchased") {
    if (existing.paidSessionId === session.id) return;
    // Opłacona inną sesją — obsługa w karcie „podwójna płatność”.
    console.warn(
      `Webhook Stripe: rezerwacja ${reservationId} opłacona inną sesją (${session.id})`,
    );
    return;
  }

  console.warn(
    `Webhook Stripe: rezerwacja ${reservationId} nie czeka na płatność (sesja ${session.id})`,
  );
}
