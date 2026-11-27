import type { ObjectId } from "mongodb";
import { z } from "zod";

// Domyślne komunikaty Zoda po polsku (kontrakt: błędy po polsku).
z.config(z.locales.pl());

export const eventSchema = z.object({
  _id: z.string(),
  title: z.string(),
  date: z.string(),
  time: z.string(),
  stage: z.string(),
  // Kwota w groszach.
  price: z.number().int().nonnegative(),
});
export type Event = z.infer<typeof eventSchema>;

// Repertuar musi wyświetlać także rekordy sprzed migracji cen Etapu II.
// Nowe dane (w tym seed) nadal wymagają poprawnego price w eventSchema.
export const catalogEventSchema = eventSchema.extend({
  price: eventSchema.shape.price.optional(),
});
export type CatalogEvent = z.infer<typeof catalogEventSchema>;

// Rząd A–H + fotel 1–10, np. "F7".
export const seatIdSchema = z
  .string({ error: "Wybierz miejsce" })
  .regex(
    /^[A-H]([1-9]|10)$/,
    "Miejsce musi mieć format rząd A–H i numer 1–10, np. F7",
  );

// Limity długości: nic ponad rozsądny rozmiar nie trafia do bazy.
const CUSTOMER_NAME_MAX = 100;
const EMAIL_MAX = 254;
const EVENT_ID_MAX = 100;

// Własne komunikaty także dla brakującego pola i złego typu —
// domyślne „oczekiwano string, otrzymano undefined” nic klientowi nie mówi.
export const createReservationSchema = z.object(
  {
    eventId: z
      .string({ error: "Wybierz spektakl" })
      .trim()
      .min(1, "Wybierz spektakl")
      .max(EVENT_ID_MAX, "Nie ma takiego spektaklu"),
    seatId: seatIdSchema,
    customerName: z
      .string({ error: "Podaj imię" })
      .trim()
      .min(1, "Podaj imię")
      .max(
        CUSTOMER_NAME_MAX,
        `Imię może mieć najwyżej ${CUSTOMER_NAME_MAX} znaków`,
      ),
    // trim przed sprawdzeniem formatu, żeby spacje z kopiuj-wklej nie dawały 400.
    email: z
      .string({ error: "Podaj adres e-mail" })
      .trim()
      .min(1, "Podaj adres e-mail")
      .max(EMAIL_MAX, "Niepoprawny adres e-mail")
      .pipe(z.email("Niepoprawny adres e-mail")),
  },
  { error: "Wyślij dane rezerwacji: spektakl, miejsce, imię i e-mail" },
);
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

// reservationId z URL: 24 znaki hex (ObjectId). Wszystko inne → 404, nigdy 500.
export const reservationIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, "Nie ma takiej rezerwacji");

export type Reservation = CreateReservationInput & {
  _id: ObjectId;
  status: "held" | "purchased";
  expiresAt: Date;
  // Cena spektaklu skopiowana w chwili rezerwacji (grosze). Później się nie
  // zmienia, nawet gdy zmieni się cena spektaklu — tyle płaci klient.
  // Starsze rezerwacje Etapu I mogą jej nie mieć.
  amount?: number;
  // Ostatnia sesja Stripe Checkout utworzona dla tej rezerwacji.
  checkoutSessionId?: string;
  // Ustawia webhook po potwierdzeniu płatności, razem z `code`.
  paidAt?: Date;
  // Sesja Checkout, która opłaciła rezerwację (ustawia webhook). Odróżnia
  // ponowiony webhook tej samej sesji od drugiej płatności (→ zwrot).
  // checkoutSessionId nie wystarcza — nadpisuje go każde nowe „Zapłać”.
  paidSessionId?: string;
  // Rozliczenie punktów po opłaceniu (ustawia webhook razem z `code`).
  // cardAmount = kwota faktycznie zapłacona kartą w opłaconej sesji (grosze),
  // pointsEarned = nagroda od tej kwoty. pointsEarnedStatus: "pending" dopóki
  // Voucherify nie potwierdzi dopisania punktów, potem "done".
  cardAmount?: number;
  pointsEarned?: number;
  pointsEarnedStatus?: "pending" | "done";
  // Punkty wydane na tę rezerwację wróciły do klienta, bo wygasła bez
  // zapłaty. Od tej chwili webhook nie zamieni jej w bilet, tylko zwróci
  // pieniądze — klient nie dostanie i biletu ze zniżką, i punktów z powrotem.
  pointsReleasedAt?: Date;
  // Punkty wydane na opłaconą sesję (ustawia webhook razem z `code`;
  // 0 przy zakupie bez punktów). cardAmount + pointsUsed = amount.
  pointsUsed?: number;
  // Próba płatności z punktami powiązana z checkoutSessionId (brak, gdy
  // ostatnie „Zapłać” było bez punktów).
  checkoutAttemptId?: string;
  code?: string;
  createdAt: Date;
};

// Body POST /api/reservations/:id/checkout. Brak body albo brak `points`
// = zakup bez punktów (zachowanie Etapu II). Kwoty nie przyjmujemy nigdy.
export const checkoutBodySchema = z.object(
  {
    points: z
      .number({ error: "Liczba punktów musi być liczbą całkowitą" })
      .int("Liczba punktów musi być liczbą całkowitą")
      .nonnegative("Liczba punktów nie może być ujemna")
      .max(Number.MAX_SAFE_INTEGER, "Za duża liczba punktów")
      .optional(),
  },
  { error: "Wyślij { points } albo puste body" },
);
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;

// Próba płatności z punktami: punkty schodzą z karty przed utworzeniem sesji
// Stripe, więc każda próba musi skończyć się zapłatą albo zwrotem punktów.
// _id = attempt w operacjach redeem:/return:<reservationId>:<attempt>.
// spending → (open | returning | failed); open → (paid | returning);
// paid → returning (tylko gdy płatność wróciła klientowi); returning → returned.
export type CheckoutAttempt = {
  _id: string;
  reservationId: string;
  email: string; // znormalizowany
  points: number; // > 0
  cardAmount: number; // amount - points, grosze
  status: "spending" | "open" | "paid" | "returning" | "returned" | "failed";
  sessionId?: string;
  // Dlaczego punkty wracają (do diagnostyki).
  returnReason?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
};

// E-mail klienta programu lojalnościowego: ten sam format co w rezerwacji,
// małymi literami — „Jan@X.pl” i „jan@x.pl” to jedno konto punktowe.
export const loyaltyEmailSchema = createReservationSchema.shape.email.transform(
  (email) => email.toLowerCase(),
);

// Powiązanie e-maila z kartą lojalnościową w Voucherify. Saldo trzyma
// wyłącznie Voucherify — tu jest kod karty i krótka kopia ostatniego odczytu.
export type LoyaltyAccount = {
  _id: string; // znormalizowany e-mail
  cardCode?: string;
  createdAt: Date;
  joinedAt?: Date;
  // Ostatnie saldo odczytane z Voucherify (cache na kilkanaście sekund,
  // żeby odpytywanie salda w pętli nie zużyło limitu zapytań Voucherify).
  balance?: number;
  balanceAt?: Date;
  // Rośnie przy każdej zmianie salda przez aplikację. Odczyt zapisuje cache
  // tylko wtedy, gdy wersja się nie zmieniła — saldo sprzed zmiany nie
  // nadpisze unieważnienia.
  balanceVersion?: number;
  // Dołączanie do programu w toku (równoległe pierwsze odczyty czekają).
  joinLeaseUntil?: Date;
  // Wydawanie punktów w toku — najwyżej jedno naraz na klienta, żeby dwie
  // rezerwacje nie wydały razem więcej, niż jest na karcie.
  spendLockToken?: string;
  spendLockUntil?: Date;
};

// Jedna zmiana salda w Voucherify (bonus, nagroda, potrącenie) ze stabilnym
// identyfikatorem. Unikalne _id gwarantuje, że operacja istnieje raz;
// status mówi, czy już się wykonała.
export type LoyaltyOperation = {
  _id: string; // np. "bonus:<email>", "earn:<reservationId>"
  email: string;
  cardCode: string;
  points: number; // > 0 dodanie, < 0 potrącenie
  reason: string;
  // pending: czeka na wykonanie (na pewno nie wykonana);
  // applying: ktoś ją właśnie wykonuje (lease);
  // unknown: ostatnia próba bez odpowiedzi (timeout, 5xx) — mogła się wykonać,
  //   przed ponowieniem trzeba sprawdzić historię karty;
  // done: Voucherify potwierdził zmianę;
  // failed: Voucherify ją odrzucił (np. za mało punktów) — bez ponowień.
  status: "pending" | "applying" | "unknown" | "done" | "failed";
  attempts: number;
  leaseToken?: string;
  leaseUntil?: Date;
  balanceAfter?: number;
  lastError?: string;
  // Tylko potrącenia (redeem:): punkty już wróciły do klienta (return:)
  // albo rezerwacja została opłacona i punkty zostają wydane.
  returnedAt?: Date;
  keptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  doneAt?: Date;
};

// Status rezerwacji w API (GET /api/reservations/:id). W bazie zostaje
// held / purchased; "expired" to held po expiresAt, liczone przez serwer.
export type ReservationApiStatus = "held" | "paid" | "expired";

// Licznik limitu: jeden dokument na klucz (np. IP) i okno czasowe.
export type RateLimitWindow = {
  _id: string;
  count: number;
  expiresAt: Date;
};
