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
import { POST as webhook } from "@/app/api/webhooks/stripe/route";
import {
  checkoutAttemptsCollection,
  ensureIndexes,
  getClient,
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
  reservationsCollection,
} from "@/lib/db";
import { getLoyaltyBalance } from "@/lib/loyalty-account";
import { releaseSpendsForReservation } from "@/lib/loyalty-spend";
import {
  finishPendingLoyaltyWork,
  listPendingLoyaltyWork,
} from "@/lib/loyalty-recovery";
import { STALE_SPENDING_MS, maxPointsFor } from "@/lib/payment-attempts";
import type { Reservation } from "@/lib/schemas";
import { CHECKOUT_SESSION_TTL_MS } from "@/lib/stripe";
import { LoyaltyUnavailableError } from "@/lib/voucherify";
import {
  createFakeVoucherify,
  type FakeVoucherify,
} from "./fixtures/fake-voucherify";

// Etap III, karta B (backend) + zagrożenie „punkty pobrane, ale płatność
// nieukończona”. Stripe i Voucherify zawsze zamockowane.
const stripeMock = vi.hoisted(() => ({
  create: vi.fn(),
  expire: vi.fn(),
  retrieve: vi.fn(),
  refund: vi.fn(),
}));
const voucherify = vi.hoisted(() => ({
  join: vi.fn(),
  get: vi.fn(),
  adjust: vi.fn(),
  has: vi.fn(),
}));

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripe: () => ({
      checkout: {
        sessions: {
          create: stripeMock.create,
          expire: stripeMock.expire,
          retrieve: stripeMock.retrieve,
        },
      },
      refunds: { create: stripeMock.refund },
    }),
    expireCheckoutSessionQuietly: async (id: string) => {
      try {
        return (await stripeMock.expire(id))?.status === "expired";
      } catch {
        return false;
      }
    },
  };
});

vi.mock("@/lib/voucherify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voucherify")>()),
  joinLoyaltyProgram: (...args: unknown[]) => voucherify.join(...args),
  getLoyaltyCard: (...args: unknown[]) => voucherify.get(...args),
  adjustLoyaltyBalance: (...args: unknown[]) => voucherify.adjust(...args),
  hasLoyaltyTransaction: (...args: unknown[]) => voucherify.has(...args),
}));

const SECRET = "whsec_test_checkout_points";
let fake: FakeVoucherify;
let sessionCounter = 0;

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://kasa.example.com");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  stripeMock.create.mockReset().mockImplementation(async () => {
    sessionCounter += 1;
    const id = `cs_test_points_${sessionCounter}_${randomUUID()}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  });
  stripeMock.expire
    .mockReset()
    .mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripeMock.retrieve.mockReset();
  stripeMock.refund.mockReset().mockResolvedValue({ id: "re_test" });
  fake = createFakeVoucherify();
  voucherify.join.mockReset().mockImplementation(fake.join);
  voucherify.get.mockReset().mockImplementation(fake.get);
  voucherify.adjust.mockReset().mockImplementation(fake.adjust);
  voucherify.has.mockReset().mockImplementation(fake.has);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("limit punktów: floor(amount / 2) (bez bazy)", () => {
  it.each([
    [6000, 3000],
    [4551, 2275],
    [1, 0],
    [0, 0],
  ])("cena %i groszy → najwyżej %i punktów", (amount, max) => {
    expect(maxPointsFor(amount)).toBe(max);
  });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function pay(id: string, body?: unknown, raw?: string) {
  return checkout(
    new Request("http://test", {
      method: "POST",
      ...(body === undefined && raw === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: raw ?? JSON.stringify(body),
          }),
    }),
    ctx(id),
  );
}

const status = (id: string) =>
  getReservation(new Request("http://test"), ctx(id));

function sessionEvent(
  type: "checkout.session.completed" | "checkout.session.expired",
  reservationId: string,
  sessionId: string,
  { amountTotal, attemptId }: { amountTotal?: number; attemptId?: string },
) {
  return {
    id: `evt_${randomUUID()}`,
    object: "event",
    type,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: reservationId,
        metadata: { reservationId, ...(attemptId ? { attemptId } : {}) },
        payment_status:
          type === "checkout.session.completed" ? "paid" : "unpaid",
        payment_intent: `pi_${sessionId}`,
        amount_total: amountTotal ?? null,
        status: type === "checkout.session.completed" ? "complete" : "expired",
      },
    },
  };
}

function send(payload: unknown) {
  const body = JSON.stringify(payload);
  return webhook(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: SECRET,
        }),
      },
      body,
    }),
  );
}

// Ostatnie wywołanie sessions.create: parametry i opcje.
function lastCreate() {
  const call = stripeMock.create.mock.calls.at(-1)!;
  const params = call[0] as {
    line_items: { price_data: { unit_amount: number } }[];
    metadata: Record<string, string>;
  };
  return {
    unitAmount: params.line_items[0].price_data.unit_amount,
    metadata: params.metadata,
    options: call[1] as { idempotencyKey?: string } | undefined,
  };
}

describe.skipIf(!process.env.MONGODB_URI)("checkout z punktami", () => {
  const EVENT_ID = `test-checkout-points-${randomUUID()}`;
  const DOMAIN = "checkout-points.test";
  let seat = 0;

  async function insert(
    overrides: Partial<Reservation> & { expiresInMs?: number } = {},
  ) {
    const { expiresInMs = 5 * 60_000, ...rest } = overrides;
    seat += 1;
    const doc: Reservation = {
      _id: new ObjectId(),
      eventId: EVENT_ID,
      seatId: `${"ABCDEFGH"[Math.floor((seat - 1) / 10) % 8]}${((seat - 1) % 10) + 1}`,
      customerName: "Jan",
      // Wielka litera: konto punktowe ma być pod znormalizowanym e-mailem.
      email: `Jan-${randomUUID()}@${DOMAIN}`,
      status: "held",
      expiresAt: new Date(Date.now() + expiresInMs),
      amount: 6000,
      createdAt: new Date(),
      ...rest,
    };
    // Każda rezerwacja na osobnym „spektaklu”, żeby miejsca się nie kończyły.
    doc.eventId = `${EVENT_ID}-${seat}`;
    await reservationsCollection().insertOne(doc);
    return {
      id: doc._id.toHexString(),
      _id: doc._id,
      email: doc.email.toLowerCase(),
    };
  }

  // Nowy klient: konto + bonus 1000 (jak po GET /api/loyalty).
  async function withBalance(email: string, balance = 1000) {
    expect(await getLoyaltyBalance(email)).toBe(1000);
    if (balance !== 1000) fake.setBalance(email, balance);
  }

  const attempt = (id: string) =>
    checkoutAttemptsCollection().findOne({ _id: id });
  const reservation = (_id: ObjectId) =>
    reservationsCollection().findOne({ _id });

  beforeAll(async () => {
    await ensureIndexes();
  });

  afterAll(async () => {
    const mine = { $regex: `@${DOMAIN.replace(".", "\\.")}$` };
    await reservationsCollection().deleteMany({
      eventId: { $regex: `^${EVENT_ID}` },
    });
    await checkoutAttemptsCollection().deleteMany({ email: mine });
    await loyaltyAccountsCollection().deleteMany({ _id: mine });
    await loyaltyOperationsCollection().deleteMany({ email: mine });
    await getClient().close();
  });

  describe("zgodność z Etapem II", () => {
    it.each([
      ["bez body", undefined],
      ["{}", {}],
      ["{ points: 0 }", { points: 0 }],
    ])("%s → sesja na pełną kwotę, bez punktów", async (_label, body) => {
      const r = await insert();
      const res = await pay(r.id, body);
      expect(res.status).toBe(200);
      expect(lastCreate().unitAmount).toBe(6000);
      expect(lastCreate().metadata).toEqual({ reservationId: r.id });
      expect(lastCreate().options).toBeUndefined();
      expect(voucherify.adjust).not.toHaveBeenCalled();
      expect(
        await checkoutAttemptsCollection().countDocuments({
          reservationId: r.id,
        }),
      ).toBe(0);
    });
  });

  describe("walidacja → 4xx bez zmiany salda i bez Stripe'a", () => {
    it.each([
      ["ujemne", { points: -1 }],
      ["ułamkowe", { points: 10.5 }],
      ["tekst", { points: "100" }],
      ["null", { points: null }],
      ["tablica zamiast obiektu", [100]],
    ])("%s points → 400", async (_label, body) => {
      const r = await insert();
      await withBalance(r.email);
      const res = await pay(r.id, body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("VALIDATION_ERROR");
      expect(stripeMock.create).not.toHaveBeenCalled();
      expect(fake.balanceOf(r.email)).toBe(1000);
    });

    it("niepoprawny JSON → 400", async () => {
      const r = await insert();
      const res = await pay(r.id, undefined, "{points:");
      expect(res.status).toBe(400);
      expect(stripeMock.create).not.toHaveBeenCalled();
    });

    it("więcej niż połowa ceny → 400 z komunikatem, saldo bez zmian", async () => {
      const r = await insert();
      await withBalance(r.email, 5000);
      const res = await pay(r.id, { points: 3001 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/połowę ceny/);
      expect(stripeMock.create).not.toHaveBeenCalled();
      expect(fake.balanceOf(r.email)).toBe(5000);
    });

    it("dokładnie połowa ceny jest dozwolona", async () => {
      const r = await insert();
      await withBalance(r.email, 5000);
      expect((await pay(r.id, { points: 3000 })).status).toBe(200);
      expect(lastCreate().unitAmount).toBe(3000);
      expect(fake.balanceOf(r.email)).toBe(2000);
    });

    it("za mało punktów → 409 INSUFFICIENT_POINTS, saldo bez zmian", async () => {
      const r = await insert();
      await withBalance(r.email);
      const res = await pay(r.id, { points: 1500 });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe("INSUFFICIENT_POINTS");
      expect(json.error).toMatch(/1000/);
      expect(stripeMock.create).not.toHaveBeenCalled();
      expect(fake.balanceOf(r.email)).toBe(1000);
    });

    it("saldo zmienione poza aplikacją jest sprawdzane w Voucherify, nie w przeglądarce", async () => {
      const r = await insert();
      await withBalance(r.email);
      fake.setBalance(r.email, 200); // klient wydał punkty w innym kanale
      const res = await pay(r.id, { points: 1000 });
      expect(res.status).toBe(409);
      expect(fake.balanceOf(r.email)).toBe(200);
    });

    it("opłacona / wygasła / nieistniejąca rezerwacja → 409 / 410 / 404 bez potrącenia", async () => {
      const paid = await insert({ status: "purchased", code: "TEA-PAID01" });
      const expired = await insert({ expiresInMs: -1000 });
      await withBalance(paid.email);
      await withBalance(expired.email);
      expect((await pay(paid.id, { points: 100 })).status).toBe(409);
      expect((await pay(expired.id, { points: 100 })).status).toBe(410);
      expect(
        (await pay(new ObjectId().toHexString(), { points: 100 })).status,
      ).toBe(404);
      expect(fake.balanceOf(paid.email)).toBe(1000);
      expect(fake.balanceOf(expired.email)).toBe(1000);
    });

    it("Voucherify nie odpowiada → 503 LOYALTY_UNAVAILABLE z Retry-After, bez Stripe'a", async () => {
      const r = await insert();
      await withBalance(r.email);
      fake.failures.get.push(
        () => new LoyaltyUnavailableError("timeout", "unknown"),
        () => new LoyaltyUnavailableError("timeout", "unknown"),
      );
      voucherify.get.mockImplementation(async (code: string) => {
        const failure = fake.failures.get.shift();
        if (failure) throw failure({});
        return fake.get(code);
      });
      const res = await pay(r.id, { points: 500 });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("LOYALTY_UNAVAILABLE");
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(stripeMock.create).not.toHaveBeenCalled();
      expect(fake.balanceOf(r.email)).toBe(1000);
    });
  });

  describe("przykład teatru: 60 zł, nowy klient wydaje 1000 punktów", () => {
    it("Stripe pobiera 50 zł, klient dostaje 500 punktów, saldo końcowe 500", async () => {
      const r = await insert();
      await withBalance(r.email);

      const res = await pay(r.id, { points: 1000 });
      expect(res.status).toBe(200);
      expect((await res.json()).url).toMatch(/^https:\/\/checkout\.stripe/);
      const created = lastCreate();
      expect(created.unitAmount).toBe(5000);
      const attemptId = created.metadata.attemptId;
      expect(created.metadata).toMatchObject({ pointsUsed: "1000" });
      expect(created.options).toEqual({
        idempotencyKey: `checkout-${attemptId}`,
      });
      expect(fake.balanceOf(r.email)).toBe(0);
      expect(await attempt(attemptId)).toMatchObject({
        status: "open",
        points: 1000,
        cardAmount: 5000,
        email: r.email,
      });

      // Przed webhookiem: nic nie jest rozliczone.
      const held = await (await status(r.id)).json();
      expect(held).toMatchObject({ status: "held", pointsUsed: 0 });
      expect(held).not.toHaveProperty("pointsEarned");

      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      const paid = sessionEvent("checkout.session.completed", r.id, sessionId, {
        amountTotal: 5000,
        attemptId,
      });
      expect((await send(paid)).status).toBe(200);

      const json = await (await status(r.id)).json();
      expect(json).toMatchObject({
        status: "paid",
        amount: 6000,
        cardAmount: 5000,
        pointsUsed: 1000,
        pointsEarned: 500,
      });
      expect(json.code).toMatch(/^TEA-/);
      expect(fake.balanceOf(r.email)).toBe(500);
      expect((await attempt(attemptId))!.status).toBe("paid");
    });

    it("ten sam webhook 10× → jeden bilet, jedno potrącenie, jedna nagroda", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 1000 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      const paid = sessionEvent("checkout.session.completed", r.id, sessionId, {
        amountTotal: 5000,
        attemptId,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => send(paid)),
      );
      expect(results.every((res) => res.status === 200)).toBe(true);
      expect(fake.balanceOf(r.email)).toBe(500);
      const card = fake.cardOf(r.email);
      const mine = fake.transactions.filter((t) => t.cardCode === card);
      expect(mine.map((t) => t.points).sort((a, b) => a - b)).toEqual([
        -1000, 500, 1000,
      ]);
      expect(stripeMock.refund).not.toHaveBeenCalled();
    });

    it("kwota kartą z niepełną złotówką: 4551 groszy − 1000 pkt → 3551 kartą → 350 pkt", async () => {
      const r = await insert({ amount: 4551 });
      await withBalance(r.email);
      await pay(r.id, { points: 1000 });
      expect(lastCreate().unitAmount).toBe(3551);
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      await send(
        sessionEvent("checkout.session.completed", r.id, sessionId, {
          amountTotal: 3551,
          attemptId,
        }),
      );
      expect(await (await status(r.id)).json()).toMatchObject({
        cardAmount: 3551,
        pointsUsed: 1000,
        pointsEarned: 350,
      });
    });
  });

  describe("zagrożenie: punkty pobrane, ale płatność nieukończona", () => {
    it("Stripe nie tworzy sesji → 503, punkty wracają", async () => {
      const r = await insert();
      await withBalance(r.email);
      stripeMock.create.mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({ message: "timeout" }),
      );
      const res = await pay(r.id, { points: 800 });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("PAYMENT_UNAVAILABLE");
      expect(fake.balanceOf(r.email)).toBe(1000);
      const [doc] = await checkoutAttemptsCollection()
        .find({ reservationId: r.id })
        .toArray();
      expect(doc).toMatchObject({
        status: "returned",
        returnReason: "stripe_failed",
      });
      expect((await reservation(r._id))!.status).toBe("held");
    });

    it("nowe „Zapłać” zastępuje sesję → stare punkty wracają, bez podwójnego potrącenia", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 1000 });
      const first = lastCreate().metadata.attemptId;
      expect(fake.balanceOf(r.email)).toBe(0);

      expect((await pay(r.id, { points: 400 })).status).toBe(200);
      const second = lastCreate().metadata.attemptId;
      expect(lastCreate().unitAmount).toBe(5600);
      expect((await attempt(first))!.status).toBe("returned");
      expect((await attempt(second))!.status).toBe("open");
      expect(fake.balanceOf(r.email)).toBe(600);

      // Trzecie „Zapłać” bez punktów: poprzednie 400 wraca.
      expect((await pay(r.id)).status).toBe(200);
      expect(lastCreate().unitAmount).toBe(6000);
      expect((await attempt(second))!.status).toBe("returned");
      expect(fake.balanceOf(r.email)).toBe(1000);
      expect((await reservation(r._id))!.checkoutAttemptId).toBeUndefined();
    });

    it("stara sesja nie dała się wygasić → punkty nie wracają do nadal płatnej sesji", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 300 });
      const first = lastCreate().metadata.attemptId;
      const firstSession = (await reservation(r._id))!.checkoutSessionId!;

      // Klient zapłacił w pierwszej karcie przeglądarki — Stripe odmawia wygaszenia.
      stripeMock.expire.mockImplementation(async (id: string) => {
        if (id === firstSession) throw new Error("session is complete");
        return { id, status: "expired" };
      });
      await pay(r.id, { points: 200 });
      const second = lastCreate().metadata.attemptId;
      const secondSession = (await reservation(r._id))!.checkoutSessionId!;
      expect((await attempt(first))!.status).toBe("open");
      expect(fake.balanceOf(r.email)).toBe(500);

      // Pierwsza sesja opłacona → bilet z jej punktami.
      await send(
        sessionEvent("checkout.session.completed", r.id, firstSession, {
          amountTotal: 5700,
          attemptId: first,
        }),
      );
      // Druga też opłacona → zwrot pieniędzy i punktów drugiej próby.
      expect(
        (
          await send(
            sessionEvent("checkout.session.completed", r.id, secondSession, {
              amountTotal: 5800,
              attemptId: second,
            }),
          )
        ).status,
      ).toBe(200);

      expect(stripeMock.refund).toHaveBeenCalledTimes(1);
      expect(stripeMock.refund.mock.calls[0][0].metadata.reason).toBe(
        "duplicate_payment",
      );
      expect(await attempt(first)).toMatchObject({ status: "paid" });
      expect(await attempt(second)).toMatchObject({
        status: "returned",
        returnReason: "duplicate_payment",
      });
      expect(await reservation(r._id)).toMatchObject({
        paidSessionId: firstSession,
        pointsUsed: 300,
        cardAmount: 5700,
        pointsEarned: 570,
      });
      // 1000 − 300 (bilet) + 570 (nagroda); 200 z drugiej próby wróciło.
      expect(fake.balanceOf(r.email)).toBe(1270);
    });

    it("sesja wygasła (webhook expired) → punkty wracają raz, także przy 10 ponowieniach", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 700 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      const expired = sessionEvent(
        "checkout.session.expired",
        r.id,
        sessionId,
        {
          attemptId,
        },
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, () => send(expired)),
      );
      // Równoległy duplikat, gdy inny właśnie oddaje punkty, dostaje 500
      // (Stripe ponowi) — nigdy drugi zwrot.
      for (const res of results) expect([200, 500]).toContain(res.status);
      expect((await send(expired)).status).toBe(200);
      expect(fake.balanceOf(r.email)).toBe(1000);
      expect(
        fake.transactions.filter((t) => t.sourceId.startsWith("return:")),
      ).toHaveLength(1);
      expect((await attempt(attemptId))!.status).toBe("returned");
      // Rezerwacja dalej czeka — klient może zapłacić jeszcze raz.
      expect((await reservation(r._id))!.status).toBe("held");
    });

    it("expired innej sesji nie oddaje punktów aktualnej próby", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 700 });
      const { attemptId } = lastCreate().metadata;
      await send(
        sessionEvent("checkout.session.expired", r.id, "cs_test_obca", {
          attemptId,
        }),
      );
      expect((await attempt(attemptId))!.status).toBe("open");
      expect(fake.balanceOf(r.email)).toBe(300);
    });

    it("spóźniony completed po oddaniu punktów → zwrot pieniędzy, bez biletu", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 1000 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      await send(
        sessionEvent("checkout.session.expired", r.id, sessionId, {
          attemptId,
        }),
      );
      const res = await send(
        sessionEvent("checkout.session.completed", r.id, sessionId, {
          amountTotal: 5000,
          attemptId,
        }),
      );
      expect(res.status).toBe(200);
      expect(stripeMock.refund).toHaveBeenCalledTimes(1);
      expect(stripeMock.refund.mock.calls[0][0].metadata.reason).toBe(
        "points_returned",
      );
      expect((await reservation(r._id))!.status).toBe("held");
      expect(fake.balanceOf(r.email)).toBe(1000);
    });

    it("rezerwacja przejęta po wygaśnięciu → zwrot pieniędzy i punktów", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 500 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      await reservationsCollection().deleteOne({ _id: r._id });
      expect(
        (
          await send(
            sessionEvent("checkout.session.completed", r.id, sessionId, {
              amountTotal: 5500,
              attemptId,
            }),
          )
        ).status,
      ).toBe(200);
      expect(stripeMock.refund.mock.calls[0][0].metadata.reason).toBe(
        "reservation_gone",
      );
      expect(fake.balanceOf(r.email)).toBe(1000);
    });

    it("Voucherify padł przy zwrocie → webhook 500 (Stripe ponowi), skrypt dokańcza", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 600 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      fake.failures.adjust.push(
        () => new LoyaltyUnavailableError("limit", "not_applied", 30),
      );
      const expired = sessionEvent(
        "checkout.session.expired",
        r.id,
        sessionId,
        {
          attemptId,
        },
      );
      expect((await send(expired)).status).toBe(500);
      expect((await attempt(attemptId))!.status).toBe("returning");
      expect(fake.balanceOf(r.email)).toBe(400);

      const work = await listPendingLoyaltyWork({ email: r.email });
      expect(work.attempts.map((a) => a.id)).toContain(attemptId);

      const report = await finishPendingLoyaltyWork({ email: r.email });
      expect(report.errors).toBe(0);
      expect((await attempt(attemptId))!.status).toBe("returned");
      expect(fake.balanceOf(r.email)).toBe(1000);

      // Ponowiony przez Stripe webhook niczego już nie zmienia.
      expect((await send(expired)).status).toBe(200);
      expect(fake.balanceOf(r.email)).toBe(1000);
    });

    it("skrypt: stara otwarta próba — expired w Stripe oddaje punkty, complete czeka na webhook", async () => {
      const a = await insert();
      const b = await insert();
      await withBalance(a.email);
      await withBalance(b.email);
      await pay(a.id, { points: 100 });
      const attemptA = lastCreate().metadata.attemptId;
      await pay(b.id, { points: 200 });
      const attemptB = lastCreate().metadata.attemptId;
      const old = new Date(Date.now() - CHECKOUT_SESSION_TTL_MS - 60_000);
      await checkoutAttemptsCollection().updateMany(
        { _id: { $in: [attemptA, attemptB] } },
        { $set: { updatedAt: old } },
      );
      const sessionB = (await attempt(attemptB))!.sessionId;
      stripeMock.retrieve.mockImplementation(async (id: string) => ({
        id,
        status: id === sessionB ? "complete" : "expired",
      }));

      await finishPendingLoyaltyWork({ email: a.email });
      await finishPendingLoyaltyWork({ email: b.email });
      expect((await attempt(attemptA))!.status).toBe("returned");
      expect((await attempt(attemptB))!.status).toBe("open");
      expect(fake.balanceOf(a.email)).toBe(1000);
      expect(fake.balanceOf(b.email)).toBe(800);
    });

    it("skrypt: próba „spending” po padnięciu procesu wraca dopiero po czasie życia sesji", async () => {
      const r = await insert();
      await withBalance(r.email);
      // Proces padł po potrąceniu, przed utworzeniem sesji.
      stripeMock.create.mockImplementationOnce(async () => {
        throw new Error("proces padł");
      });
      await expect(pay(r.id, { points: 300 })).rejects.toThrow();
      const [doc] = await checkoutAttemptsCollection()
        .find({ reservationId: r.id })
        .toArray();
      // Nieoczekiwany błąd: zwrot i tak poszedł od razu (brak sesji).
      expect(doc.status).toBe("returned");

      // Ręcznie odtworzona sytuacja „spending” bez sesji.
      await withBalance(r.email);
      const stuck = randomUUID();
      const now = new Date();
      await checkoutAttemptsCollection().insertOne({
        _id: stuck,
        reservationId: r.id,
        email: r.email,
        points: 100,
        cardAmount: 5900,
        status: "spending",
        createdAt: now,
        updatedAt: now,
      });
      const fresh = await listPendingLoyaltyWork({ email: r.email });
      expect(fresh.attempts.map((a) => a.id)).not.toContain(stuck);
      await checkoutAttemptsCollection().updateOne(
        { _id: stuck },
        { $set: { updatedAt: new Date(Date.now() - STALE_SPENDING_MS - 1) } },
      );
      await finishPendingLoyaltyWork({ email: r.email });
      // Potrącenia nie było — nic nie zmienia salda, próba zamknięta.
      expect((await attempt(stuck))!.status).toBe("returned");
      expect(fake.balanceOf(r.email)).toBe(1000);
    });
  });

  describe("razem ze zwrotem punktów z wygasłej rezerwacji (#29)", () => {
    it("rezerwacja wygasła, punkty wróciły, potem spóźniona płatność → zwrot pieniędzy, punkty raz", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 1000 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;

      // Rezerwacja wygasła bez zapłaty → punkty wracają (odczyt salda / skrypt).
      await reservationsCollection().updateOne(
        { _id: r._id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      await releaseSpendsForReservation(r.id);
      expect(fake.balanceOf(r.email)).toBe(1000);

      // Sesja była jeszcze otwarta i klient zapłacił.
      const res = await send(
        sessionEvent("checkout.session.completed", r.id, sessionId, {
          amountTotal: 5000,
          attemptId,
        }),
      );
      expect(res.status).toBe(200);
      expect(stripeMock.refund.mock.calls[0][0].metadata.reason).toBe(
        "points_released",
      );
      expect((await reservation(r._id))!.status).toBe("held");
      expect((await attempt(attemptId))!.status).toBe("returned");
      // Potem wygasa sesja — nic się już nie zmienia.
      await send(
        sessionEvent("checkout.session.expired", r.id, sessionId, {
          attemptId,
        }),
      );
      expect(fake.balanceOf(r.email)).toBe(1000);
      expect(
        fake.transactions.filter((t) => t.sourceId.startsWith("return:")),
      ).toHaveLength(1);
    });

    it("najpierw expired sesji, potem zwrot z wygasłej rezerwacji → punkty wracają raz", async () => {
      const r = await insert();
      await withBalance(r.email);
      await pay(r.id, { points: 400 });
      const { attemptId } = lastCreate().metadata;
      const sessionId = (await reservation(r._id))!.checkoutSessionId!;
      await send(
        sessionEvent("checkout.session.expired", r.id, sessionId, {
          attemptId,
        }),
      );
      await reservationsCollection().updateOne(
        { _id: r._id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      await releaseSpendsForReservation(r.id);
      expect(fake.balanceOf(r.email)).toBe(1000);
      expect(
        fake.transactions.filter((t) => t.sourceId.startsWith("return:")),
      ).toHaveLength(1);
    });
  });

  describe("równoległość", () => {
    it("5 równoległych „Zapłać” z punktami: saldo nigdy ujemne, wydane = punkty otwartej próby", async () => {
      const r = await insert();
      await withBalance(r.email);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => pay(r.id, { points: 600 })),
      );
      const codes = results.map((res) => res.status);
      expect(codes).toContain(200);
      for (const code of codes) expect([200, 409, 503]).toContain(code);

      const balance = fake.balanceOf(r.email)!;
      expect(balance).toBeGreaterThanOrEqual(0);
      const held = await checkoutAttemptsCollection()
        .find({
          reservationId: r.id,
          status: { $in: ["spending", "open", "returning"] },
        })
        .toArray();
      const stillSpent = held.reduce((sum, a) => sum + a.points, 0);
      expect(1000 - balance).toBe(stillSpent);
      // Opłacić da się tylko ostatnią zapisaną sesję.
      const current = await reservation(r._id);
      expect(held.filter((a) => a.status === "open").map((a) => a._id)).toEqual(
        [current!.checkoutAttemptId],
      );
    });

    it("dwie rezerwacje jednego klienta nie wydadzą razem więcej, niż ma", async () => {
      const email = `Ola-${randomUUID()}@${DOMAIN}`;
      const a = await insert({ email });
      const b = await insert({ email });
      await withBalance(a.email);
      const [ra, rb] = await Promise.all([
        pay(a.id, { points: 700 }),
        pay(b.id, { points: 700 }),
      ]);
      const ok = [ra, rb].filter((res) => res.status === 200);
      expect(ok).toHaveLength(1);
      expect(fake.balanceOf(a.email)).toBe(300);
    });
  });
});
