import { SEED_EVENTS } from "./seed-events.ts";
export { SEED_EVENTS } from "./seed-events.ts";
import { ObjectId } from "mongodb";
import type { Reservation } from "./schemas.ts";
const PURCHASED_SEATS = [
  { eventId: "dziady", seatId: "A1", code: "TEA-7F3K9Q" },
  { eventId: "dziady", seatId: "F7", code: "TEA-4M8R2W" },
  { eventId: "wesele", seatId: "C5", code: "TEA-9K3D6H" },
  { eventId: "kordian", seatId: "B3", code: "TEA-5Q7N2X" },
  { eventId: "kordian", seatId: "H10", code: "TEA-8W4J6P" },
] as const;

export function createSeedReservations(
  now: Date,
): (Reservation & { amount: number })[] {
  return PURCHASED_SEATS.map(({ eventId, seatId, code }) => ({
    _id: new ObjectId(),
    eventId,
    seatId,
    amount: SEED_EVENTS.find((event) => event._id === eventId)!.price,
    customerName: "Gość przykładowy",
    email: "bilet@example.com",
    status: "purchased",
    expiresAt: now,
    code,
    createdAt: now,
  }));
}
