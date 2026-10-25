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
});
export type Event = z.infer<typeof eventSchema>;

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
  code?: string;
  createdAt: Date;
};
