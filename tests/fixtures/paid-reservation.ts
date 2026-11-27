import { ObjectId } from "mongodb";
import type { Event, Reservation } from "../../lib/schemas.ts";

export const paidEvent: Event = {
  _id: "test-mail",
  title: "Dziady",
  date: "2026-12-15",
  time: "19:00",
  stage: "Duża Scena",
  price: 6000,
};
export const paidReservation: Reservation = {
  _id: new ObjectId("1234567890abcdef12345678"),
  eventId: paidEvent._id,
  seatId: "F7",
  customerName: "Klient testowy",
  email: "delivered@resend.dev",
  status: "purchased",
  code: "TEA-TEST01",
  amount: 6000,
  cardAmount: 5000,
  pointsUsed: 1000,
  pointsEarned: 500,
  createdAt: new Date("2026-11-20T12:00:00Z"),
  expiresAt: new Date("2026-11-20T12:15:00Z"),
};
