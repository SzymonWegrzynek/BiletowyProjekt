import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
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
import {
  ensureIndexes,
  getClient,
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
  reservationsCollection,
} from "@/lib/db";
import { getLoyaltyBalance } from "@/lib/loyalty-account";
import { LOYALTY_RECONCILE_DELAY_MS } from "@/lib/loyalty-operations";
import {
  finishPendingLoyaltyWork,
  listPendingLoyaltyWork,
} from "@/lib/loyalty-recovery";
import { awardPurchasePoints } from "@/lib/loyalty-rewards";
import { spendLoyaltyPoints, spendOperationId } from "@/lib/loyalty-spend";
import type { Reservation } from "@/lib/schemas";
import { LoyaltyUnavailableError } from "@/lib/voucherify";
import {
  createFakeVoucherify,
  type FakeVoucherify,
} from "./fixtures/fake-voucherify";

// Voucherify w testach jest zamockowany — awarie symulujemy w atrapie.
const voucherify = vi.hoisted(() => ({
  join: vi.fn(),
  get: vi.fn(),
  adjust: vi.fn(),
  has: vi.fn(),
}));

vi.mock("@/lib/voucherify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voucherify")>()),
  joinLoyaltyProgram: (...args: unknown[]) => voucherify.join(...args),
  getLoyaltyCard: (...args: unknown[]) => voucherify.get(...args),
  adjustLoyaltyBalance: (...args: unknown[]) => voucherify.adjust(...args),
  hasLoyaltyTransaction: (...args: unknown[]) => voucherify.has(...args),
}));

let fake: FakeVoucherify;

beforeEach(() => {
  fake = createFakeVoucherify();
  voucherify.join.mockReset().mockImplementation(fake.join);
  voucherify.get.mockReset().mockImplementation(fake.get);
  voucherify.adjust.mockReset().mockImplementation(fake.adjust);
  voucherify.has.mockReset().mockImplementation(fake.has);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const down = () => new LoyaltyUnavailableError("timeout", "unknown");
const limited = () => new LoyaltyUnavailableError("limit", "not_applied", 60);

describe.skipIf(!process.env.MONGODB_URI)("awarie Voucherify", () => {
  const DOMAIN = "loyalty-outage.test";
  const EVENT_ID = `test-outage-${randomUUID()}`;
  const newEmail = () => `klient-${randomUUID()}@${DOMAIN}`;
  // Pliki testów chodzą równolegle na jednej bazie — skrypt tylko dla „naszych”.
  const scope = { email: new RegExp(`@${DOMAIN.replace(".", "\\.")}$`) };
  const finish = () => finishPendingLoyaltyWork(scope);
  let seat = 0;

  // Opłacony bilet z nagrodą czekającą na Voucherify (jak po webhooku
  // w czasie awarii).
  async function paidWithPendingReward(email: string, points = 600) {
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
      pointsEarned: points,
      pointsEarnedStatus: "pending",
      createdAt: now,
    };
    await reservationsCollection().insertOne(doc);
    return doc;
  }

  const reward = (doc: Reservation) =>
    reservationsCollection().findOne({ _id: doc._id });
  const earnedFor = (doc: Reservation) =>
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

  it("odczyt w czasie awarii → 503 (nie 0, nie nowy bonus); po powrocie usługi → 1000", async () => {
    const email = newEmail();
    const url = `http://test/api/loyalty?email=${encodeURIComponent(email)}`;
    fake.failures.join.push(down);

    const during = await getLoyalty(new Request(url));
    expect(during.status).toBe(503);
    expect(fake.transactions).toHaveLength(0);

    const after = await getLoyalty(new Request(url));
    expect(await after.json()).toEqual({ email, points: 1000 });
  });

  it("nie da się potwierdzić salda → płatność punktami nie rusza, nic nie potrącone", async () => {
    const email = newEmail();
    await getLoyaltyBalance(email);
    const reservationId = randomUUID();
    fake.failures.get.push(down);

    await expect(
      spendLoyaltyPoints({ email, reservationId, attempt: "cs", points: 300 }),
    ).rejects.toBeInstanceOf(LoyaltyUnavailableError);
    expect(voucherify.adjust).toHaveBeenCalledTimes(1); // tylko bonus
    expect(
      await loyaltyOperationsCollection().findOne({
        _id: spendOperationId(reservationId, "cs"),
      }),
    ).toBeNull();
    expect(fake.balanceOf(email)).toBe(1000);
  });

  it("awaria nagrody po zapłacie → bilet zostaje, nagroda pending; skrypt ją dokańcza raz", async () => {
    const email = newEmail();
    const doc = await paidWithPendingReward(email);
    fake.failures.adjust.push(limited);

    await expect(awardPurchasePoints(doc._id)).resolves.toBe("pending");
    expect(await reward(doc)).toMatchObject({
      status: "purchased",
      code: doc.code,
      pointsEarnedStatus: "pending",
    });

    const listed = await listPendingLoyaltyWork(scope);
    expect(listed.rewards.map((r) => r.reservationId)).toContain(
      doc._id.toHexString(),
    );

    const report = await finish();
    expect(report.finished).toBeGreaterThanOrEqual(1);
    expect((await reward(doc))?.pointsEarnedStatus).toBe("done");
    expect(earnedFor(doc).map((t) => t.points)).toEqual([600]);

    // Drugie uruchomienie nic nie dubluje.
    await finish();
    expect(earnedFor(doc)).toHaveLength(1);
  });

  it("nagroda z nieznanym wynikiem → skrypt czeka, potem rozstrzyga bez podwójnej nagrody", async () => {
    const email = newEmail();
    const doc = await paidWithPendingReward(email, 450);
    fake.failures.adjustAfterApply.push(down);

    await expect(awardPurchasePoints(doc._id)).resolves.toBe("pending");
    const id = `earn:${doc._id.toHexString()}`;
    expect(
      (await loyaltyOperationsCollection().findOne({ _id: id }))?.status,
    ).toBe("unknown");

    // Za wcześnie na rozstrzygnięcie — nic się nie zmienia.
    const early = await finish();
    expect(early.waiting).toBeGreaterThanOrEqual(1);
    expect(earnedFor(doc)).toHaveLength(1);

    await loyaltyOperationsCollection().updateOne(
      { _id: id },
      {
        $set: {
          updatedAt: new Date(Date.now() - LOYALTY_RECONCILE_DELAY_MS - 1000),
        },
      },
    );
    await finish();
    expect((await reward(doc))?.pointsEarnedStatus).toBe("done");
    expect(earnedFor(doc).map((t) => t.points)).toEqual([450]);
  });

  it("limit zapytań w trakcie dokańczania → przerywa, nie przedłuża limitu", async () => {
    const first = await paidWithPendingReward(newEmail());
    const second = await paidWithPendingReward(newEmail());
    // Najstarsze w kolejce, first przed second.
    await reservationsCollection().updateOne(
      { _id: first._id },
      { $set: { paidAt: new Date(0) } },
    );
    await reservationsCollection().updateOne(
      { _id: second._id },
      { $set: { paidAt: new Date(1000) } },
    );
    // Pierwsza nagroda trafia na limit; drugiej skrypt już nie próbuje.
    fake.failures.join.push(limited);

    const report = await finish();
    expect(report.stoppedByLimit).toBe(true);
    expect(voucherify.join).toHaveBeenCalledTimes(1);
    expect((await reward(second))?.pointsEarnedStatus).toBe("pending");
  });

  it("niedokończone potrącenie → skrypt go nie wykonuje (rozstrzyga ścieżka płatności)", async () => {
    const email = newEmail();
    await getLoyaltyBalance(email);
    const reservationId = randomUUID();
    fake.failures.adjust.push(
      () => new LoyaltyUnavailableError("limit", "not_applied"),
    );
    await expect(
      spendLoyaltyPoints({ email, reservationId, attempt: "cs", points: 300 }),
    ).rejects.toThrow();

    const listed = await listPendingLoyaltyWork(scope);
    expect(listed.operations).toContainEqual(
      expect.objectContaining({
        id: spendOperationId(reservationId, "cs"),
        autoFinish: false,
      }),
    );
    await finish();
    expect(fake.balanceOf(email)).toBe(1000);
  });
});
