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
import { GET as getLoyalty } from "@/app/api/loyalty/route";
import { POST as webhook } from "@/app/api/webhooks/stripe/route";
import {
  ensureIndexes,
  getClient,
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
  reservationsCollection,
} from "@/lib/db";
import { getLoyaltyBalance } from "@/lib/loyalty-account";
import {
  parseSpendOperationId,
  spendLoyaltyPoints,
  spendOperationId,
} from "@/lib/loyalty-spend";
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
  has: vi.fn(),
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
  hasLoyaltyTransaction: (...args: unknown[]) => voucherify.has(...args),
}));

const SECRET = "whsec_test_points_release";
let fake: FakeVoucherify;

beforeEach(() => {
  fake = createFakeVoucherify();
  voucherify.join.mockReset().mockImplementation(fake.join);
  voucherify.get.mockReset().mockImplementation(fake.get);
  voucherify.adjust.mockReset().mockImplementation(fake.adjust);
  voucherify.has.mockReset().mockImplementation(fake.has);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  stripeMock.refund.mockReset().mockResolvedValue({ id: "re_test" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parseSpendOperationId (bez bazy)", () => {
  it("rozbiera redeem:<rezerwacja>:<próba>, odrzuca resztę", () => {
    expect(parseSpendOperationId("redeem:abc:cs_1:x")).toEqual({
      reservationId: "abc",
      attempt: "cs_1:x",
    });
    expect(parseSpendOperationId("earn:abc")).toBeUndefined();
    expect(parseSpendOperationId("redeem:abc")).toBeUndefined();
    expect(parseSpendOperationId("redeem::x")).toBeUndefined();
    expect(parseSpendOperationId("redeem:abc:")).toBeUndefined();
  });
});

describe.skipIf(!process.env.MONGODB_URI)(
  "punkty z nieopłaconej rezerwacji wracają bez harmonogramu",
  () => {
    const DOMAIN = "points-release.test";
    const EVENT_ID = `test-release-${randomUUID()}`;
    const newEmail = () => `klient-${randomUUID()}@${DOMAIN}`;
    let seat = 0;

    function sessionEvent(reservationId: string, amountTotal = 5000) {
      const sessionId = `cs_test_${randomUUID()}`;
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
            payment_status: "paid",
            payment_intent: `pi_${sessionId}`,
            amount_total: amountTotal,
          },
        },
      };
    }

    function sendWebhook(payload: unknown) {
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

    async function balanceViaApi(email: string) {
      const res = await getLoyalty(
        new Request(
          `http://test/api/loyalty?email=${encodeURIComponent(email)}`,
        ),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { points: number }).points;
    }

    // Klient (1000 pkt) zarezerwował miejsce i wydał na nie punkty w checkoucie.
    async function heldWithSpentPoints(points = 300) {
      const email = newEmail();
      await getLoyaltyBalance(email); // bonus 1000
      seat += 1;
      const now = new Date();
      const doc: Reservation = {
        _id: new ObjectId(),
        eventId: EVENT_ID,
        seatId: `${"ABCDEFGH"[Math.floor((seat - 1) / 10)]}${((seat - 1) % 10) + 1}`,
        customerName: "Jan",
        email,
        status: "held",
        expiresAt: new Date(now.getTime() + 60_000),
        amount: 6000,
        createdAt: now,
      };
      await reservationsCollection().insertOne(doc);
      const reservationId = doc._id.toHexString();
      await spendLoyaltyPoints({
        email,
        reservationId,
        attempt: "cs_1",
        points,
      });
      expect(fake.balanceOf(email)).toBe(1000 - points);
      return { email, doc, reservationId };
    }

    const expire = (doc: Reservation) =>
      reservationsCollection().updateOne(
        { _id: doc._id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
    const returnsFor = (reservationId: string) =>
      fake.transactions.filter((t) =>
        t.sourceId.startsWith(`return:${reservationId}:`),
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

    it("III.B3: rezerwacja wygasła bez zapłaty → najbliższy odczyt salda oddaje punkty, raz", async () => {
      const { email, doc, reservationId } = await heldWithSpentPoints();
      await expire(doc);

      expect(await balanceViaApi(email)).toBe(1000);
      expect(await balanceViaApi(email)).toBe(1000);
      expect(returnsFor(reservationId).map((t) => t.points)).toEqual([300]);
      const after = await reservationsCollection().findOne({ _id: doc._id });
      expect(after?.pointsReleasedAt).toBeInstanceOf(Date);
      const spend = await loyaltyOperationsCollection().findOne({
        _id: spendOperationId(reservationId, "cs_1"),
      });
      expect(spend?.returnedAt).toBeInstanceOf(Date);
    });

    it("ważna rezerwacja → punkty zostają wydane", async () => {
      const { email, reservationId } = await heldWithSpentPoints();
      expect(await balanceViaApi(email)).toBe(700);
      expect(returnsFor(reservationId)).toHaveLength(0);
    });

    it("III.B4: punkty wróciły, potem spóźniona płatność kartą → zwrot pieniędzy, bez biletu", async () => {
      const { email, doc, reservationId } = await heldWithSpentPoints();
      await expire(doc);
      expect(await balanceViaApi(email)).toBe(1000);

      const res = await sendWebhook(sessionEvent(reservationId));
      expect(res.status).toBe(200);
      expect(stripeMock.refund).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reason: "points_released" }),
        }),
        expect.anything(),
      );
      const after = await reservationsCollection().findOne({ _id: doc._id });
      expect(after?.status).toBe("held");
      expect(after?.code).toBeUndefined();
      expect(returnsFor(reservationId)).toHaveLength(1);
      expect(fake.balanceOf(email)).toBe(1000);
    });

    it("spóźniona płatność przed zwrotem punktów → bilet, punkty zostają wydane", async () => {
      const { email, doc, reservationId } = await heldWithSpentPoints();
      await expire(doc);

      const res = await sendWebhook(sessionEvent(reservationId, 5700));
      expect(res.status).toBe(200);
      expect(stripeMock.refund).not.toHaveBeenCalled();
      const after = await reservationsCollection().findOne({ _id: doc._id });
      expect(after?.status).toBe("purchased");
      expect(after?.pointsReleasedAt).toBeUndefined();

      // 700 po wydaniu + 570 nagrody za 57 zł kartą; bez zwrotu 300.
      expect(await balanceViaApi(email)).toBe(1270);
      expect(returnsFor(reservationId)).toHaveLength(0);
      const spend = await loyaltyOperationsCollection().findOne({
        _id: spendOperationId(reservationId, "cs_1"),
      });
      expect(spend?.keptAt).toBeInstanceOf(Date);
    });

    it("III.B4: miejsce przejął ktoś inny, X płaci kartą → zwrot pieniędzy i punktów od razu w webhooku", async () => {
      const { email, doc, reservationId } = await heldWithSpentPoints();
      // POST /api/reservations osoby Y usuwa wygasłą rezerwację X.
      await reservationsCollection().deleteOne({ _id: doc._id });

      const res = await sendWebhook(sessionEvent(reservationId));
      expect(res.status).toBe(200);
      expect(stripeMock.refund).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reason: "reservation_gone" }),
        }),
        expect.anything(),
      );
      expect(fake.balanceOf(email)).toBe(1000); // bez odczytu salda
      expect(returnsFor(reservationId)).toHaveLength(1);
    });

    it("Voucherify nie odpowiada przy zwrocie → odczyt salda i tak odpowiada; kolejny oddaje punkty", async () => {
      const { email, doc, reservationId } = await heldWithSpentPoints();
      await expire(doc);
      fake.failures.adjust.push(
        () => new LoyaltyUnavailableError("limit", "not_applied", 1),
      );

      expect(await balanceViaApi(email)).toBe(700);
      expect(await balanceViaApi(email)).toBe(1000);
      expect(returnsFor(reservationId)).toHaveLength(1);
    });

    it("III.A2: nagroda zaległa po awarii Voucherify → dopisana przy odczycie salda", async () => {
      const email = newEmail();
      await getLoyaltyBalance(email);
      seat += 1;
      const now = new Date();
      const doc: Reservation = {
        _id: new ObjectId(),
        eventId: EVENT_ID,
        seatId: `${"ABCDEFGH"[Math.floor((seat - 1) / 10)]}${((seat - 1) % 10) + 1}`,
        customerName: "Jan",
        email,
        status: "purchased",
        expiresAt: now,
        amount: 6000,
        code: `TEA-${randomUUID().slice(0, 6).toUpperCase()}`,
        paidAt: now,
        cardAmount: 6000,
        pointsEarned: 600,
        pointsEarnedStatus: "pending",
        createdAt: now,
      };
      await reservationsCollection().insertOne(doc);

      expect(await balanceViaApi(email)).toBe(1600);
      const after = await reservationsCollection().findOne({ _id: doc._id });
      expect(after?.pointsEarnedStatus).toBe("done");
    });
  },
);
