import { SEED_EVENTS } from "./seed-events.ts";
export const STUB_EVENTS = SEED_EVENTS.map((event) => ({ ...event }));
export const STUB_TAKEN_SEATS = ["A1", "A2", "C5", "F7"];

// Etap II — przykładowe odpowiedzi nowych endpointów (kształt z kontraktu).
export const STUB_RESERVATION_RESPONSE = {
  reservationId: "6740c0ffee0000000000abcd",
  expiresAt: "2026-11-14T18:15:00.000Z",
  amount: 6000,
};

// POST /api/reservations/:id/checkout → 200 { url }
export const STUB_CHECKOUT_RESPONSE = {
  url: "https://checkout.stripe.com/c/pay/cs_test_zaslepka",
};

// GET /api/reservations/:id dla każdego statusu.
export const STUB_RESERVATION_STATUS = {
  held: {
    status: "held",
    amount: 6000,
    expiresAt: "2026-11-14T18:15:00.000Z",
  },
  paid: {
    status: "paid",
    amount: 6000,
    expiresAt: "2026-11-14T18:15:00.000Z",
    code: "TEA-7F3K9Q",
  },
  expired: {
    status: "expired",
    amount: 6000,
    expiresAt: "2026-11-14T18:00:00.000Z",
  },
} as const;

// Etap III — saldo nowego klienta (frontend A/B na zaślepce).
export const STUB_LOYALTY_POINTS = 1000;

// Etap IV: wyłącznie przykłady kontraktu; endpointy produkcyjne ich nie używają.
export const STUB_WAITLIST_ID = "6740c0ffee00000000000001";
export const STUB_WAITLIST_EVENT = {
  _id: "waitlist-test",
  title: "Wieczór teatralny — lista oczekujących",
  date: "2026-12-15",
  time: "19:00",
  stage: "Scena Kameralna",
  price: 4500,
  seats: ["A1", "A2"],
};
export const STUB_WAITLIST_STATUS = {
  waiting: { status: "waiting", position: 2 },
  offered: {
    status: "offered",
    position: 0,
    reservationId: "6740c0ffee00000000000002",
    offerExpiresAt: "2026-12-15T17:15:00.000Z",
    seatId: "A1",
  },
  done: {
    status: "done",
    position: 0,
    reservationId: "6740c0ffee00000000000002",
  },
  missed: { status: "missed", position: 0 },
  left: { status: "left", position: 0 },
} as const;
