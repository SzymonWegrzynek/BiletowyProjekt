import { randomUUID } from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import Stripe from "stripe";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GET as getReservation } from "@/app/api/reservations/[id]/route";
import { POST as webhook } from "@/app/api/webhooks/stripe/route";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  reservationsCollection,
} from "@/lib/db";
import type { Event, Reservation } from "@/lib/schemas";

// Stripe w testach jest zamockowany — żadnych prawdziwych zapytań.
// Podpis sprawdza prawdziwe Stripe.webhooks (nie potrzebuje sieci ani klucza).
const stripeMock = vi.hoisted(() => ({ refund: vi.fn() }));

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripe: () => ({ refunds: { create: stripeMock.refund } }),
  };
});

const SECRET = "whsec_test_webhook_secret";

type SessionOptions = {
  sessionId?: string;
  type?: string;
  paymentStatus?: string;
  paymentIntent?: string | null;
  reservationId?: string | null;
};

function sessionEvent(reservationId: string, options: SessionOptions = {}) {
  const {
    sessionId = `cs_test_${randomUUID()}`,
    type = "checkout.session.completed",
    paymentStatus = "paid",
    paymentIntent = `pi_${sessionId}`,
  } = options;
  const id = options.reservationId === undefined ? reservationId : null;
  return {
    id: `evt_${randomUUID()}`,
    object: "event",
    type,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: id,
        metadata: id ? { reservationId: id } : {},
        payment_status: paymentStatus,
        payment_intent: paymentIntent,
      },
    },
  };
}

function sign(body: string, secret = SECRET) {
  return Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

function send(payload: unknown, headers?: Record<string, string>) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return webhook(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: headers ?? { "stripe-signature": sign(body) },
      body,
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  stripeMock.refund.mockReset().mockResolvedValue({ id: "re_test" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("webhook Stripe — podpis (bez bazy)", () => {
  const id = new ObjectId().toHexString();

  it("brak nagłówka stripe-signature → 400 VALIDATION_ERROR", async () => {
    const res = await send(sessionEvent(id), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("podpis innym sekretem → 400", async () => {
    const body = JSON.stringify(sessionEvent(id));
    const res = await send(body, {
      "stripe-signature": sign(body, "whsec_obcy"),
    });
    expect(res.status).toBe(400);
  });

  it("zmienione body po podpisaniu → 400", async () => {
    const body = JSON.stringify(sessionEvent(id));
    const forged = body.replace('"paid"', '"paid" ');
    const res = await send(forged, { "stripe-signature": sign(body) });
    expect(res.status).toBe(400);
  });

  it("brak STRIPE_WEBHOOK_SECRET → 503 (Stripe ponowi), a nie 500", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const res = await send(sessionEvent(id));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe.skipIf(!process.env.MONGODB_URI)("webhook Stripe", () => {
  const EVENT: Event = {
    _id: `test-webhook-${randomUUID()}`,
    title: "Dziady",
    date: "2026-11-14",
    time: "19:00",
    stage: "Duża Scena",
    price: 6000,
  };
  const reservations = () => reservationsCollection();
  let seat = 0;

  // Każdy test na osobnym miejscu, żeby unikalny indeks ich nie mieszał.
  async function insert(
    overrides: Partial<Reservation> & { expiresInMs?: number } = {},
  ): Promise<Reservation> {
    seat += 1;
    const { expiresInMs = 5 * 60_000, ...rest } = overrides;
    const now = Date.now();
    const doc: Reservation = {
      _id: new ObjectId(),
      eventId: EVENT._id,
      seatId: `${"ABCDEFGH"[Math.floor((seat - 1) / 10)]}${((seat - 1) % 10) + 1}`,
      customerName: "Jan",
      email: "jan@example.com",
      status: "held",
      expiresAt: new Date(now + expiresInMs),
      amount: 6000,
      createdAt: new Date(now),
      ...rest,
    };
    await reservations().insertOne(doc);
    return doc;
  }

  const find = (doc: Reservation) => reservations().findOne({ _id: doc._id });

  beforeAll(async () => {
    await ensureIndexes();
    await eventsCollection().insertOne(EVENT);
  });

  afterAll(async () => {
    await reservations().deleteMany({ eventId: EVENT._id });
    await eventsCollection().deleteOne({ _id: EVENT._id });
    await getClient().close();
  });

  it("opłacona sesja → purchased z kodem, paidAt i paidSessionId; GET mówi paid", async () => {
    const doc = await insert();
    const id = doc._id.toHexString();
    const event = sessionEvent(id, { sessionId: "cs_test_glowna" });

    const res = await send(event);
    expect(res.status).toBe(200);

    const saved = await find(doc);
    expect(saved?.status).toBe("purchased");
    expect(saved?.code).toMatch(/^TEA-[A-Z0-9]{6}$/);
    expect(saved?.paidAt).toBeInstanceOf(Date);
    expect(saved?.paidSessionId).toBe("cs_test_glowna");
    expect(stripeMock.refund).not.toHaveBeenCalled();

    const status = await getReservation(new Request("http://test"), {
      params: Promise.resolve({ id }),
    });
    expect(await status.json()).toMatchObject({
      status: "paid",
      code: saved?.code,
    });
  });

  it("sfałszowane żądanie niczego nie zmienia", async () => {
    const doc = await insert();
    const body = JSON.stringify(sessionEvent(doc._id.toHexString()));
    const res = await send(body, { "stripe-signature": "t=1,v1=deadbeef" });
    expect(res.status).toBe(400);
    expect((await find(doc))?.status).toBe("held");
  });

  it.each([
    ["inny typ zdarzenia", { type: "checkout.session.expired" }],
    ["sesja nieopłacona", { paymentStatus: "unpaid" }],
  ])("%s → 200 bez zmian", async (_name, options) => {
    const doc = await insert();
    const res = await send(sessionEvent(doc._id.toHexString(), options));
    expect(res.status).toBe(200);
    const saved = await find(doc);
    expect(saved?.status).toBe("held");
    expect(saved?.code).toBeUndefined();
  });

  it("ten sam webhook 10× równolegle → wszystkie 2xx, jeden kod, bez zwrotu", async () => {
    const doc = await insert();
    const event = sessionEvent(doc._id.toHexString());

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => send(event)),
    );
    expect(responses.map((res) => res.status)).toEqual(Array(10).fill(200));

    const saved = await find(doc);
    expect(saved?.status).toBe("purchased");
    const code = saved?.code;

    // Kolejne ponowienie po chwili też nie zmienia kodu.
    expect((await send(event)).status).toBe(200);
    expect((await find(doc))?.code).toBe(code);
    expect(stripeMock.refund).not.toHaveBeenCalled();
  });

  it("błąd bazy → 500 (Stripe ponowi), rezerwacja bez zmian", async () => {
    const doc = await insert();
    vi.spyOn(Collection.prototype, "findOneAndUpdate").mockRejectedValueOnce(
      new Error("baza niedostępna"),
    );
    const res = await send(sessionEvent(doc._id.toHexString()));
    expect(res.status).toBe(500);
    expect((await find(doc))?.status).toBe("held");
  });
});
