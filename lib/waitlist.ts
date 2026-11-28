import { z } from "zod";
import {
  createReservationSchema,
  reservationIdSchema,
  seatIdSchema,
} from "./schemas.ts";

// Kontrakt z kart Etapu IV. Nie implementuje backendu A/B.
export const waitlistIdSchema = reservationIdSchema;
export const joinWaitlistSchema = createReservationSchema.pick({
  customerName: true,
  email: true,
});
export type JoinWaitlistInput = z.infer<typeof joinWaitlistSchema>;
export const joinedWaitlistSchema = z.object({
  waitlistId: waitlistIdSchema,
  position: z.number().int().positive(),
});
export const waitlistStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("waiting"),
    position: z.number().int().positive(),
  }),
  z.object({
    status: z.literal("offered"),
    position: z.number().int().nonnegative().nullable(),
    reservationId: reservationIdSchema,
    offerExpiresAt: z.iso.datetime(),
    // Opcjonalne rozszerzenie: podstawowy kontrakt Trello nie zwraca miejsca.
    seatId: seatIdSchema.optional(),
  }),
  z.object({
    status: z.literal("done"),
    position: z.number().int().nonnegative().nullable(),
    reservationId: reservationIdSchema.optional(),
  }),
  z.object({
    status: z.literal("missed"),
    position: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    status: z.literal("left"),
    position: z.number().int().nonnegative().nullable(),
  }),
]);
export type WaitlistStatus = z.infer<typeof waitlistStatusSchema>;

export const DEFAULT_SEATS = Array.from(
  { length: 80 },
  (_, i) => `${String.fromCharCode(65 + Math.floor(i / 10))}${(i % 10) + 1}`,
);
export const seatPlanSchema = z
  .array(seatIdSchema)
  .min(1)
  .max(80)
  .refine((seats) => new Set(seats).size === seats.length);
export function eventSeats(event: { seats?: string[] }): string[] {
  return event.seats === undefined
    ? DEFAULT_SEATS
    : seatPlanSchema.parse(event.seats);
}
export function remainingOfferSeconds(expiresAt: string, now: number) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}
