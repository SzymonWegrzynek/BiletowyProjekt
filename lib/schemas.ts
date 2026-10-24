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
  .string()
  .regex(
    /^[A-H]([1-9]|10)$/,
    "Miejsce musi mieć format rząd A–H i numer 1–10, np. F7",
  );

export const createReservationSchema = z.object({
  eventId: z.string().trim().min(1, "Wybierz spektakl"),
  seatId: seatIdSchema,
  customerName: z.string().trim().min(1, "Podaj imię"),
  email: z.email("Niepoprawny adres e-mail"),
});
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export type Reservation = CreateReservationInput & {
  _id: ObjectId;
  status: "held" | "purchased";
  expiresAt: Date;
  code?: string;
  createdAt: Date;
};
