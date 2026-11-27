import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
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
import { POST as checkout } from "@/app/api/reservations/[id]/checkout/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  reservationsCollection,
} from "@/lib/db";
import type { Event, Reservation } from "@/lib/schemas";
import {
  CHECKOUT_SESSION_TTL_MS,
  PaymentConfigError,
  isPaymentUnavailable,
} from "@/lib/stripe";

// Stripe w testach jest zamockowany — żadnych prawdziwych zapytań.
const stripeMock = vi.hoisted(() => ({
  create: vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripe: () => ({
      checkout: {
        sessions: { create: stripeMock.create, expire: stripeMock.expire },
      },
    }),
    expireCheckoutSessionQuietly: async (id: string) => {
      await stripeMock.expire(id);
    },
  };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const pay = (id: string) =>
  checkout(new Request("http://test", { method: "POST" }), ctx(id));
const status = (id: string) =>
  getReservation(new Request("http://test"), ctx(id));

let sessionCounter = 0;
function fakeSession() {
  sessionCounter += 1;
  const id = `cs_test_${sessionCounter}`;
  return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
}

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://kasa.example.com/");
  stripeMock.create.mockReset().mockImplementation(async () => fakeSession());
  stripeMock.expire.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Stripe — bez bazy", () => {
  it.each(["xyz", "123", "nie-objectid-24-znakowy!"])(
    "404 dla niepoprawnego id %s w /checkout i GET (a nie 500)",
    async (id) => {
      for (const res of [await pay(id), await status(id)]) {
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe("NOT_FOUND");
      }
      expect(stripeMock.create).not.toHaveBeenCalled();
    },
  );

  it("awaria Stripe'a i brak konfiguracji to „płatności niedostępne”, zwykły błąd nie", () => {
    expect(
      isPaymentUnavailable(new Stripe.errors.StripeConnectionError()),
    ).toBe(true);
    expect(isPaymentUnavailable(new Stripe.errors.StripeAPIError())).toBe(true);
    expect(isPaymentUnavailable(new PaymentConfigError("brak klucza"))).toBe(
      true,
    );
    expect(isPaymentUnavailable(new Error("bug w kodzie"))).toBe(false);
    expect(
      isPaymentUnavailable(new Stripe.errors.StripeInvalidRequestError()),
    ).toBe(false);
  });

  it("brak STRIPE_SECRET_KEY → PaymentConfigError, a nie wyciek do klienta", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(() => actual.getStripe()).toThrow(actual.PaymentConfigError);
  });
});

describe.skipIf(!process.env.MONGODB_URI)("Etap II: płatności", () => {
  const EVENT: Event = {
    _id: `test-platnosci-${randomUUID()}`,
    title: "Dziady",
    date: "2026-11-14",
    time: "19:00",
    stage: "Duża Scena",
    price: 6000,
  };
  const reservations = () => reservationsCollection();
  let seat = 0;

  function reserve(seatId: string) {
    return createReservation(
      new Request("http://test/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: EVENT._id,
          seatId,
          customerName: "Jan",
          email: "jan@example.com",
        }),
      }),
    );
  }

  // Każdy test na osobnym miejscu, żeby unikalny indeks ich nie mieszał.
  async function insert(
    overrides: Partial<Reservation> & { expiresInMs?: number } = {},
  ): Promise<string> {
    seat += 1;
    const { expiresInMs = 5 * 60_000, ...rest } = overrides;
    const now = Date.now();
    const doc: Reservation = {
      _id: new ObjectId(),
      eventId: EVENT._id,
      seatId: `D${seat}`,
      customerName: "Jan",
      email: "jan@example.com",
      status: "held",
      expiresAt: new Date(now + expiresInMs),
      amount: 4321,
      createdAt: new Date(now),
      ...rest,
    };
    await reservations().insertOne(doc);
    return doc._id.toHexString();
  }

  async function expectError(res: Response, httpStatus: number, code: string) {
    expect(res.status).toBe(httpStatus);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["code", "error"]);
    expect(json.code).toBe(code);
  }

  beforeAll(async () => {
    await ensureIndexes();
    await eventsCollection().insertOne(EVENT);
  });

  afterAll(async () => {
    await reservations().deleteMany({ eventId: EVENT._id });
    await eventsCollection().deleteOne({ _id: EVENT._id });
    await getClient().close();
  });

  describe("price i amount", () => {
    it("rezerwacja kopiuje cenę spektaklu do amount (odpowiedź i baza)", async () => {
      const res = await reserve("A1");
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.amount).toBe(6000);

      const saved = await reservations().findOne({
        _id: new ObjectId(json.reservationId),
      });
      expect(saved?.amount).toBe(6000);
    });

    it("ścieżka idempotentna (200) też zwraca amount", async () => {
      const first = await (await reserve("A2")).json();
      const again = await reserve("A2");
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
    });

    it("zmiana ceny spektaklu nie zmienia amount istniejącej rezerwacji", async () => {
      const { reservationId } = await (await reserve("A3")).json();
      await eventsCollection().updateOne(
        { _id: EVENT._id },
        { $set: { price: 9900 } },
      );
      try {
        const saved = await reservations().findOne({
          _id: new ObjectId(reservationId),
        });
        expect(saved?.amount).toBe(6000);
        expect((await (await status(reservationId)).json()).amount).toBe(6000);
      } finally {
        await eventsCollection().updateOne(
          { _id: EVENT._id },
          { $set: { price: EVENT.price } },
        );
      }
    });
  });

  describe("POST /api/reservations/:id/checkout", () => {
    it("200 { url }: sesja z kwotą z bazy, adresami powrotu i id rezerwacji", async () => {
      const id = await insert();
      const before = Date.now();
      const res = await pay(id);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Object.keys(json)).toEqual(["url"]);
      expect(json.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

      expect(stripeMock.create).toHaveBeenCalledTimes(1);
      const params = stripeMock.create.mock.calls[0][0];
      expect(params).toMatchObject({
        mode: "payment",
        client_reference_id: id,
        metadata: { reservationId: id },
        customer_email: "jan@example.com",
        success_url: `https://kasa.example.com/rezerwacja/${id}/platnosc`,
        cancel_url: `https://kasa.example.com/rezerwacja/${id}?anulowano=1`,
      });
      expect(params.line_items).toHaveLength(1);
      expect(params.line_items[0].price_data).toMatchObject({
        currency: "pln",
        unit_amount: 4321,
      });
      // Sesja żyje najkrócej, jak pozwala Stripe (≥ 30 min).
      expect(params.expires_at * 1000).toBeGreaterThanOrEqual(
        before + 30 * 60_000,
      );
      expect(params.expires_at * 1000).toBeLessThanOrEqual(
        Date.now() + CHECKOUT_SESSION_TTL_MS,
      );

      const saved = await reservations().findOne({ _id: new ObjectId(id) });
      expect(saved?.checkoutSessionId).toBe(
        (await stripeMock.create.mock.results[0].value).id,
      );
      // Utworzenie sesji niczego nie opłaca.
      expect(saved?.status).toBe("held");
      expect(saved?.code).toBeUndefined();
    });

    it("ponowne „Zapłać” wygasza poprzednią sesję i zapisuje nową", async () => {
      const id = await insert();
      await pay(id);
      const first = await stripeMock.create.mock.results[0].value;
      await pay(id);
      const second = await stripeMock.create.mock.results[1].value;

      expect(stripeMock.expire).toHaveBeenCalledWith(first.id);
      expect(stripeMock.expire).not.toHaveBeenCalledWith(second.id);
      const saved = await reservations().findOne({ _id: new ObjectId(id) });
      expect(saved?.checkoutSessionId).toBe(second.id);
    });

    it("410 RESERVATION_EXPIRED dla wygasłej rezerwacji, bez sesji Stripe", async () => {
      const id = await insert({ expiresInMs: -60_000 });
      await expectError(await pay(id), 410, "RESERVATION_EXPIRED");
      expect(stripeMock.create).not.toHaveBeenCalled();
    });

    it("409 ALREADY_PAID dla opłaconej rezerwacji", async () => {
      const id = await insert({ status: "purchased", code: generateCode() });
      await expectError(await pay(id), 409, "ALREADY_PAID");
      expect(stripeMock.create).not.toHaveBeenCalled();
    });

    it("404 dla nieistniejącej rezerwacji", async () => {
      await expectError(
        await pay(new ObjectId().toHexString()),
        404,
        "NOT_FOUND",
      );
    });

    it("Stripe nie odpowiada → 503 PAYMENT_UNAVAILABLE + Retry-After, rezerwacja bez zmian", async () => {
      const id = await insert();
      const before = await reservations().findOne({ _id: new ObjectId(id) });
      stripeMock.create.mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({ message: "timeout" }),
      );
      vi.spyOn(console, "error").mockImplementationOnce(() => {});

      const res = await pay(id);
      expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
      await expectError(res, 503, "PAYMENT_UNAVAILABLE");
      expect(await reservations().findOne({ _id: new ObjectId(id) })).toEqual(
        before,
      );

      // Rezerwacja dalej ważna — kolejna próba się udaje.
      expect((await pay(id)).status).toBe(200);
    });

    it("brak APP_URL → 503, a nie 500", async () => {
      const id = await insert();
      vi.stubEnv("APP_URL", "");
      vi.spyOn(console, "error").mockImplementationOnce(() => {});
      await expectError(await pay(id), 503, "PAYMENT_UNAVAILABLE");
    });
  });

  describe("GET /api/reservations/:id", () => {
    it("held: ważna rezerwacja, bez kodu i bez danych klienta", async () => {
      const id = await insert();
      const res = await status(id);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const json = await res.json();
      // Etap III dopisuje pointsUsed (0 do czasu opłacenia).
      expect(Object.keys(json).sort()).toEqual([
        "amount",
        "expiresAt",
        "pointsUsed",
        "status",
      ]);
      expect(json).toMatchObject({
        status: "held",
        amount: 4321,
        pointsUsed: 0,
      });
      expect(new Date(json.expiresAt).toISOString()).toBe(json.expiresAt);
    });

    it("paid: purchased → status paid z kodem", async () => {
      const code = generateCode();
      const id = await insert({
        status: "purchased",
        code,
        paidAt: new Date(),
      });
      const json = await (await status(id)).json();
      // Stary zakup bez rozliczenia punktów: pointsUsed 0, bez pointsEarned.
      expect(Object.keys(json).sort()).toEqual([
        "amount",
        "code",
        "expiresAt",
        "pointsUsed",
        "status",
      ]);
      expect(json).toMatchObject({ status: "paid", code, pointsUsed: 0 });
    });

    it("expired: held po expiresAt", async () => {
      const id = await insert({ expiresInMs: -1_000 });
      const json = await (await status(id)).json();
      expect(json.status).toBe("expired");
      expect(json.code).toBeUndefined();
    });

    it("404 dla nieistniejącej rezerwacji, też no-store", async () => {
      const res = await status(new ObjectId().toHexString());
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      await expectError(res, 404, "NOT_FOUND");
    });
  });
});

// Unikalny kod testowy — indeks na code jest unikalny w całej kolekcji.
function generateCode(): string {
  return `TEA-T${randomUUID().slice(0, 8).toUpperCase()}`;
}
