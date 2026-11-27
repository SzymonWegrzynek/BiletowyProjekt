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
import { POST as webhook } from "@/app/api/webhooks/stripe/route";
import {
  ensureIndexes,
  getClient,
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
  reservationsCollection,
} from "@/lib/db";
import { pointsForCardPayment } from "@/lib/loyalty-rewards";
import type { Reservation } from "@/lib/schemas";
import { LoyaltyUnavailableError } from "@/lib/voucherify";
import {
  createFakeVoucherify,
  type FakeVoucherify,
} from "./fixtures/fake-voucherify";

// Stripe i Voucherify w testach są zamockowane — żadnych prawdziwych zapytań.
const stripeMock = vi.hoisted(() => ({ refund: vi.fn() }));
const voucherify = vi.hoisted(() => ({
  join: vi.fn(),
  get: vi.fn(),
  adjust: vi.fn(),
}));

vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe")>()),
  getStripe: () => ({ refunds: { create: stripeMock.refund } }),
}));

vi.mock("@/lib/voucherify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voucherify")>()),
  joinLoyaltyProgram: (...args: unknown[]) => voucherify.join(...args),
  getLoyaltyCard: (...args: unknown[]) => voucherify.get(...args),
  adjustLoyaltyBalance: (...args: unknown[]) => voucherify.adjust(...args),
}));

const SECRET = "whsec_test_purchase_points";
let fake: FakeVoucherify;

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  stripeMock.refund.mockReset().mockResolvedValue({ id: "re_test" });
  fake = createFakeVoucherify();
  voucherify.join.mockReset().mockImplementation(fake.join);
  voucherify.get.mockReset().mockImplementation(fake.get);
  voucherify.adjust.mockReset().mockImplementation(fake.adjust);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("nagroda: floor(kwotaKartą / 100) * 10 (bez bazy)", () => {
  it.each([
    [5000, 500], // 60 zł − 1000 punktów = 50 zł kartą
    [6000, 600],
    [4550, 450], // niepełna złotówka nie daje punktów
    [99, 0],
    [0, 0],
  ])("%i groszy kartą → %i punktów", (cardAmount, points) => {
    expect(pointsForCardPayment(cardAmount)).toBe(points);
  });
});

function paidSession(
  reservationId: string,
  {
    amountTotal = 6000,
    paymentStatus = "paid",
    sessionId = `cs_test_${randomUUID()}`,
  }: { amountTotal?: number; paymentStatus?: string; sessionId?: string } = {},
) {
  return {
    id: `evt_${randomUUID()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: reservationId,
        metadata: { reservationId },
        payment_status: paymentStatus,
        payment_intent: `pi_${sessionId}`,
        amount_total: amountTotal,
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

describe.skipIf(!process.env.MONGODB_URI)("punkty za opłacony zakup", () => {
  const EVENT_ID = `test-points-${randomUUID()}`;
  const DOMAIN = "purchase-points.test";
  let seat = 0;

  async function insert(): Promise<Reservation> {
    seat += 1;
    const now = Date.now();
    const doc: Reservation = {
      _id: new ObjectId(),
      eventId: EVENT_ID,
      seatId: `${"ABCDEFGH"[Math.floor((seat - 1) / 10)]}${((seat - 1) % 10) + 1}`,
      customerName: "Jan",
      // Wielka litera: konto punktowe ma być pod znormalizowanym e-mailem.
      email: `Jan-${randomUUID()}@${DOMAIN}`,
      status: "held",
      expiresAt: new Date(now + 5 * 60_000),
      amount: 6000,
      createdAt: new Date(now),
    };
    await reservationsCollection().insertOne(doc);
    return doc;
  }

  const find = (doc: Reservation) =>
    reservationsCollection().findOne({ _id: doc._id });
  const earned = (doc: Reservation) =>
    fake.transactions.filter(
      (t) => t.sourceId === `earn:${doc._id.toHexString()}`,
    );

  beforeAll(async () => {
    await ensureIndexes();
  });

  afterAll(async () => {
    const mine = { $regex: `@${DOMAIN.replace(".", "\\.")}$` };
    await reservationsCollection().deleteMany({ eventId: EVENT_ID });
    await loyaltyAccountsCollection().deleteMany({ _id: mine });
    await loyaltyOperationsCollection().deleteMany({ email: mine });
    await getClient().close();
  });

  it("6000 groszy, 1000 punktami → 5000 kartą, 500 punktów w Voucherify", async () => {
    const doc = await insert();
    const res = await send(
      paidSession(doc._id.toHexString(), { amountTotal: 5000 }),
    );
    expect(res.status).toBe(200);

    expect(await find(doc)).toMatchObject({
      status: "purchased",
      cardAmount: 5000,
      pointsEarned: 500,
      pointsEarnedStatus: "done",
    });
    expect(earned(doc)).toEqual([
      expect.objectContaining({
        points: 500,
        cardCode: fake.cardOf(doc.email.toLowerCase()),
      }),
    ]);
  });

  it("4550 groszy kartą → 450 punktów", async () => {
    const doc = await insert();
    await send(paidSession(doc._id.toHexString(), { amountTotal: 4550 }));
    expect((await find(doc))?.pointsEarned).toBe(450);
    expect(earned(doc).map((t) => t.points)).toEqual([450]);
  });

  it("poniżej złotówki kartą → 0 punktów, bez zapytania do Voucherify", async () => {
    const doc = await insert();
    await send(paidSession(doc._id.toHexString(), { amountTotal: 99 }));
    expect(await find(doc)).toMatchObject({
      pointsEarned: 0,
      pointsEarnedStatus: "done",
    });
    expect(voucherify.adjust).not.toHaveBeenCalled();
  });

  it("brak zapłaty (payment_status ≠ paid) → bez biletu i bez punktów", async () => {
    const doc = await insert();
    await send(paidSession(doc._id.toHexString(), { paymentStatus: "unpaid" }));
    const saved = await find(doc);
    expect(saved?.status).toBe("held");
    expect(saved?.pointsEarned).toBeUndefined();
    expect(voucherify.adjust).not.toHaveBeenCalled();
  });

  it("druga opłacona sesja → zwrot i bez drugiej nagrody", async () => {
    const doc = await insert();
    const id = doc._id.toHexString();
    await send(paidSession(id, { amountTotal: 6000 }));
    await send(paidSession(id, { amountTotal: 6000 }));
    expect(stripeMock.refund).toHaveBeenCalledTimes(1);
    expect(earned(doc).map((t) => t.points)).toEqual([600]);
  });

  it("rezerwacji już nie ma → zwrot, bez punktów", async () => {
    const id = new ObjectId().toHexString();
    await send(paidSession(id));
    expect(stripeMock.refund).toHaveBeenCalledTimes(1);
    expect(voucherify.adjust).not.toHaveBeenCalled();
  });

  it("Voucherify nie odpowiada → bilet jest, nagroda pending; ponowienie ją dokańcza raz", async () => {
    const doc = await insert();
    const event = paidSession(doc._id.toHexString(), { amountTotal: 6000 });
    fake.failures.adjust.push(
      () => new LoyaltyUnavailableError("limit", "not_applied"),
    );

    const first = await send(event);
    expect(first.status).toBe(200);
    expect(await find(doc)).toMatchObject({
      status: "purchased",
      pointsEarned: 600,
      pointsEarnedStatus: "pending",
    });
    expect(earned(doc)).toHaveLength(0);

    await send(event);
    expect((await find(doc))?.pointsEarnedStatus).toBe("done");
    expect(earned(doc).map((t) => t.points)).toEqual([600]);
  });

  it("ten sam webhook 10× równolegle → jedna nagroda", async () => {
    const doc = await insert();
    const event = paidSession(doc._id.toHexString(), { amountTotal: 6000 });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => send(event)),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    // Kolejne ponowienie dokańcza, jeśli któreś trafiło na trwającą operację.
    await send(event);
    expect(earned(doc).map((t) => t.points)).toEqual([600]);
    expect((await find(doc))?.pointsEarnedStatus).toBe("done");
  });
});
