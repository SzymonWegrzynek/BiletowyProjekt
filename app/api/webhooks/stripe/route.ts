import { MongoServerError, ObjectId } from "mongodb";
import type Stripe from "stripe";
import { checkoutAttemptsCollection, reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import {
  awardPurchasePoints,
  purchaseRewardFields,
} from "@/lib/loyalty-rewards";
import { releaseSpendsForReservation } from "@/lib/loyalty-spend";
import {
  claimAttemptForPayment,
  compensateAttempt,
} from "@/lib/payment-attempts";
import { reservationIdSchema } from "@/lib/schemas";
import {
  PAYMENT_RETRY_AFTER_SECONDS,
  PaymentConfigError,
  constructWebhookEvent,
  getStripe,
  isSignatureError,
  refundPayment,
  type RefundReason,
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

  // Wygasła sesja z punktami: nikt jej już nie opłaci, punkty wracają.
  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    const attemptId = session.metadata?.attemptId;
    if (!attemptId) return received();
    try {
      await returnAttemptPoints(attemptId, "session_expired", {
        sessionId: session.id,
      });
    } catch (error) {
      console.error(`Webhook Stripe: punkty sesji ${session.id}`, error);
      return new Response("Nie oddano punktów", { status: 500 });
    }
    return received();
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
  // Sesji bez naszej rezerwacji nie da się zamienić na bilet → zwrot.
  if (!parsed.success) {
    await refund(session, "", "unknown_reservation");
    return;
  }

  const reservationId = parsed.data;
  const _id = new ObjectId(reservationId);
  const reservations = reservationsCollection();
  const paidAt = new Date();

  // Sesja z punktami: punkty bierzemy z próby w bazie (nie z metadata),
  // a próba przechodzi open → paid. Gdy jej punkty zostały już oddane
  // (sesję uznaliśmy za nieopłacalną), biletu za samą dopłatę nie ma — zwrot.
  const attemptId = session.metadata?.attemptId;
  let pointsUsed = 0;
  if (attemptId) {
    const claim = await claimAttemptForPayment(attemptId, session.id);
    if (claim.status === "returned") {
      await refund(session, reservationId, "points_returned");
      return;
    }
    if (
      claim.status === "missing" ||
      claim.attempt.reservationId !== reservationId
    ) {
      // Sesja z naszego /checkout zawsze ma swoją próbę — rzucamy, żeby
      // Stripe ponowił, zamiast wydać bilet bez rozliczenia punktów.
      throw new Error(`Sesja ${session.id}: brak próby płatności ${attemptId}`);
    }
    pointsUsed = claim.attempt.points;
  }

  // Nagroda od kwoty faktycznie zapłaconej kartą w TEJ sesji (z podpisanego
  // zdarzenia) — część opłacona punktami jej nie daje.
  const cardAmount = session.amount_total;
  const reward =
    typeof cardAmount === "number" && Number.isSafeInteger(cardAmount)
      ? purchaseRewardFields(cardAmount)
      : undefined;
  if (!reward) {
    console.error(`Sesja ${session.id} bez amount_total — bez nagrody`);
  }

  // Jeden warunkowy zapis, jak zakup w Etapie I. Filtr celowo BEZ expiresAt:
  // dopóki dokument "held" istnieje, nikt inny nie ma tego miejsca (unikalny
  // indeks { eventId, seatId }), więc spóźniona płatność daje bilet —
  // chyba że punkty wydane na tę rezerwację już wróciły do klienta
  // (pointsReleasedAt, lib/loyalty-spend.ts). Ten sam warunek w zapisie
  // rozstrzyga wyścig ze zwrotem punktów.
  // Drugi raz filtr już nie pasuje — ponowiony webhook niczego nie zmienia.
  // E11000 może tu dać tylko kolizja kodu → losujemy nowy.
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    try {
      const updated = await reservations.findOneAndUpdate(
        { _id, status: "held", pointsReleasedAt: { $exists: false } },
        {
          $set: {
            status: "purchased",
            code: generateTicketCode(),
            paidAt,
            paidSessionId: session.id,
            pointsUsed,
            ...reward,
          },
        },
        { returnDocument: "after", projection: { _id: 1 } },
      );
      if (updated) {
        // Bilet już jest. Punkty dopisujemy po nim — awaria Voucherify
        // zostawia nagrodę "pending", ale nie zabiera biletu.
        await awardPurchasePoints(_id);
        return;
      }
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
    { projection: { status: 1, paidSessionId: 1, pointsReleasedAt: 1 } },
  );

  // Ta sama sesja drugi raz (ponowienie Stripe'a) — bilet już jest.
  if (existing?.status === "purchased") {
    if (existing.paidSessionId === session.id) {
      // Ponowienie — przy okazji dokańczamy nagrodę, jeśli poprzednio
      // Voucherify nie odpowiedział (operacja wykona się najwyżej raz).
      await awardPurchasePoints(_id);
      return;
    }
    // Opłacona inną sesją (dwie karty, podwójny klik) — druga płatność wraca.
    await refund(session, reservationId, "duplicate_payment");
    await returnAttemptPoints(attemptId, "duplicate_payment", {
      allowPaid: true,
    });
    return;
  }

  if (!existing) {
    // Rezerwacja wygasła, a miejsce przejął ktoś inny (POST /api/reservations
    // usuwa wygasłą "held") — biletu nie będzie, więc zwrot pieniędzy
    // i punktów wydanych na tę rezerwację.
    await refund(session, reservationId, "reservation_gone");
    await returnSpentPointsQuietly(reservationId);
    await returnAttemptPoints(attemptId, "reservation_gone", {
      allowPaid: true,
    });
    return;
  }

  if (existing.pointsReleasedAt) {
    // Rezerwacja wygasła, a punkty wydane na nią już wróciły do klienta —
    // spóźniona płatność wraca w całości (pieniądze i punkty, bez biletu).
    await refund(session, reservationId, "points_released");
    await returnSpentPointsQuietly(reservationId);
    // Próba tej sesji jest już "paid" (zajęta przed zapisem biletu) —
    // jej punkty wróciły wyżej, tu tylko domykamy jej stan.
    await returnAttemptPoints(attemptId, "points_released", {
      allowPaid: true,
    });
    return;
  }

  // "held", a zapis nie trafił — nie powinno się zdarzyć. Rzucamy, żeby
  // Stripe ponowił zamiast zgubić płatność.
  throw new Error(`Rezerwacja ${reservationId} w nieoczekiwanym stanie`);
}

// Pieniądze już wracają, więc webhook odpowiada 2xx także przy awarii
// Voucherify — punkty dokończy odczyt salda klienta (GET /api/loyalty)
// albo pnpm loyalty:pending --finish.
async function returnSpentPointsQuietly(reservationId: string): Promise<void> {
  try {
    await releaseSpendsForReservation(reservationId);
  } catch (error) {
    console.error(
      `Punkty z rezerwacji ${reservationId} czekają na zwrot`,
      error,
    );
  }
}

// Zwrot punktów próby. Gdy Voucherify nie odpowiada, rzucamy — webhook
// odpowie 500 i Stripe ponowi zdarzenie (zwrot pieniędzy ma klucz
// idempotencji, zwrot punktów jest operacją jednorazową). Próba zostaje
// "returning", więc dokończy ją też pnpm loyalty:pending --finish.
async function returnAttemptPoints(
  attemptId: string | undefined,
  reason: string,
  {
    allowPaid = false,
    sessionId,
  }: { allowPaid?: boolean; sessionId?: string } = {},
): Promise<void> {
  if (!attemptId) return;
  if (sessionId) {
    // Wygasła sesja musi być sesją tej próby (albo próbą bez zapisanej sesji).
    const claim = await checkoutAttemptsCollection().findOne(
      { _id: attemptId },
      { projection: { sessionId: 1 } },
    );
    if (!claim || (claim.sessionId && claim.sessionId !== sessionId)) return;
  }
  const result = await compensateAttempt(attemptId, reason, { allowPaid });
  if (result === "pending") {
    throw new Error(`Zwrot punktów próby ${attemptId} czeka na Voucherify`);
  }
}

async function refund(
  session: Stripe.Checkout.Session,
  reservationId: string,
  reason: RefundReason,
): Promise<void> {
  const paymentIntent = session.payment_intent;
  const paymentIntentId =
    typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
  if (!paymentIntentId) {
    throw new Error(`Sesja ${session.id} bez payment_intent — brak zwrotu`);
  }
  await refundPayment(getStripe(), {
    sessionId: session.id,
    paymentIntentId,
    reservationId,
    reason,
  });
}
