import { randomUUID } from "node:crypto";
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
} from "@/lib/db";
import { getLoyaltyBalance } from "@/lib/loyalty-account";
import {
  LOYALTY_RECONCILE_DELAY_MS,
  applyLoyaltyOperation,
} from "@/lib/loyalty-operations";
import {
  InsufficientPointsError,
  returnSpentPoints,
  spendLoyaltyPoints,
  spendOperationId,
} from "@/lib/loyalty-spend";
import { LoyaltyUnavailableError } from "@/lib/voucherify";
import {
  createFakeVoucherify,
  type FakeVoucherify,
} from "./fixtures/fake-voucherify";

// Voucherify w testach jest zamockowany — żadnych prawdziwych zapytań.
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

const timeout = () => new LoyaltyUnavailableError("timeout", "unknown");

describe.skipIf(!process.env.MONGODB_URI)("operacje punktowe", () => {
  const DOMAIN = "loyalty-concurrency.test";
  const newEmail = () => `klient-${randomUUID()}@${DOMAIN}`;
  const operations = () => loyaltyOperationsCollection();
  const sourced = (sourceId: string) =>
    fake.transactions.filter((t) => t.sourceId === sourceId);

  // Klient z bonusem 1000 punktów.
  async function customer(): Promise<{ email: string; cardCode: string }> {
    const email = newEmail();
    await getLoyaltyBalance(email);
    return { email, cardCode: fake.cardOf(email)! };
  }

  // Niepewna próba „sprzed minuty” — wolno ją już rozstrzygać.
  async function age(id: string) {
    await operations().updateOne(
      { _id: id },
      {
        $set: {
          updatedAt: new Date(Date.now() - LOYALTY_RECONCILE_DELAY_MS - 1000),
        },
      },
    );
  }

  beforeAll(async () => {
    await ensureIndexes();
  });

  afterAll(async () => {
    const mine = { $regex: `@${DOMAIN.replace(".", "\\.")}$` };
    await loyaltyAccountsCollection().deleteMany({ _id: mine });
    await operations().deleteMany({ email: mine });
    await getClient().close();
  });

  describe("bonus i konto przy równoległych odczytach", () => {
    it("10 równoległych pierwszych odczytów → jedna karta, jeden bonus, wszędzie 1000", async () => {
      const email = newEmail();
      const url = `http://test/api/loyalty?email=${encodeURIComponent(email)}`;
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => getLoyalty(new Request(url))),
      );
      const bodies = await Promise.all(responses.map((res) => res.json()));

      expect(responses.map((res) => res.status)).toEqual(Array(10).fill(200));
      expect(bodies).toEqual(Array(10).fill({ email, points: 1000 }));
      expect(voucherify.join).toHaveBeenCalledTimes(1);
      expect(sourced(`bonus:${email}`)).toHaveLength(1);
    });
  });

  describe("timeout z nieznanym wynikiem", () => {
    const input = (cardCode: string, email: string) => ({
      id: `test-op:${randomUUID()}`,
      email,
      cardCode,
      points: 300,
      reason: "Test",
    });

    it("zmiana się wykonała, odpowiedź zginęła → unknown; bez drugiej zmiany", async () => {
      const { email, cardCode } = await customer();
      const op = input(cardCode, email);
      fake.failures.adjustAfterApply.push(timeout);

      await expect(applyLoyaltyOperation(op)).rejects.toThrow("timeout");
      expect(await operations().findOne({ _id: op.id })).toMatchObject({
        status: "unknown",
      });

      // Od razu po timeoucie: nie powtarzamy w ciemno.
      await expect(applyLoyaltyOperation(op)).resolves.toEqual({
        status: "in_progress",
      });
      expect(voucherify.has).not.toHaveBeenCalled();

      // Po odczekaniu: historia karty mówi, że transakcja jest → done bez zmiany.
      await age(op.id);
      await expect(applyLoyaltyOperation(op)).resolves.toMatchObject({
        status: "done",
        appliedNow: false,
      });
      expect(sourced(op.id)).toHaveLength(1);
      expect(fake.balanceOf(email)).toBe(1300);
    });

    it("zmiana się nie wykonała → po rozstrzygnięciu wykonana raz", async () => {
      const { email, cardCode } = await customer();
      const op = input(cardCode, email);
      fake.failures.adjust.push(timeout);

      await expect(applyLoyaltyOperation(op)).rejects.toThrow("timeout");
      await age(op.id);
      await expect(applyLoyaltyOperation(op)).resolves.toMatchObject({
        status: "done",
        appliedNow: true,
      });
      expect(sourced(op.id)).toHaveLength(1);
      expect(fake.balanceOf(email)).toBe(1300);
    });

    it("rozstrzygnięcie też bez odpowiedzi → zostaje unknown, bez zmiany salda", async () => {
      const { email, cardCode } = await customer();
      const op = input(cardCode, email);
      fake.failures.adjust.push(timeout);
      await expect(applyLoyaltyOperation(op)).rejects.toThrow();
      await age(op.id);
      fake.failures.has.push(timeout);

      await expect(applyLoyaltyOperation(op)).rejects.toThrow();
      expect((await operations().findOne({ _id: op.id }))?.status).toBe(
        "unknown",
      );
      expect(sourced(op.id)).toHaveLength(0);
    });

    it("proces padł w trakcie (applying, lease minął) → rozstrzygane, nie powtarzane", async () => {
      const { email, cardCode } = await customer();
      const op = input(cardCode, email);
      await fake.adjust(cardCode, op.points, { sourceId: op.id, reason: "x" });
      const past = new Date(Date.now() - 60_000);
      await operations().insertOne({
        _id: op.id,
        email,
        cardCode,
        points: op.points,
        reason: op.reason,
        status: "applying",
        attempts: 1,
        leaseToken: "dead",
        leaseUntil: past,
        createdAt: past,
        updatedAt: past,
      });

      await expect(applyLoyaltyOperation(op)).resolves.toMatchObject({
        status: "done",
        appliedNow: false,
      });
      expect(sourced(op.id)).toHaveLength(1);
    });
  });

  describe("wydawanie punktów", () => {
    it("powtórzony checkout (ten sam attempt, równolegle) → jedno potrącenie", async () => {
      const { email } = await customer();
      const reservationId = randomUUID();
      const spend = () =>
        spendLoyaltyPoints({
          email,
          reservationId,
          attempt: "cs_1",
          points: 500,
        });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, spend),
      );
      // Kto nie dostał blokady, dostaje „spróbuj za chwilę”, nie drugie potrącenie.
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(LoyaltyUnavailableError);
        }
      }
      await spend(); // ponowienie po chwili
      expect(sourced(spendOperationId(reservationId, "cs_1"))).toHaveLength(1);
      expect(fake.balanceOf(email)).toBe(500);
    });

    it("dwie rezerwacje naraz po 800 z 1000 → jedna przechodzi, saldo nie spada poniżej 0", async () => {
      const { email } = await customer();
      const spend = (reservationId: string) =>
        spendLoyaltyPoints({
          email,
          reservationId,
          attempt: "cs",
          points: 800,
        });

      const first = await Promise.allSettled([spend("r-1"), spend("r-2")]);
      // Odrzucona (blokada albo saldo) próbuje jeszcze raz, już po kolei.
      const retried = await Promise.allSettled(
        first.map((result, index) =>
          result.status === "fulfilled"
            ? Promise.resolve(result.value)
            : spend(`r-${index + 1}`),
        ),
      );

      expect(retried.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = retried.find((r) => r.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
        InsufficientPointsError,
      );
      expect(fake.balanceOf(email)).toBe(200);
    });

    it("saldo zmienione poza aplikacją między sprawdzeniem a potrąceniem → punkty wracają, odmowa", async () => {
      const { email } = await customer();
      const reservationId = randomUUID();
      // Inny kanał wydaje 900 punktów tuż po naszym odczycie salda.
      voucherify.get.mockImplementationOnce(async (code: string) => {
        const card = await fake.get(code);
        fake.setBalance(email, 100);
        return card;
      });

      await expect(
        spendLoyaltyPoints({
          email,
          reservationId,
          attempt: "cs",
          points: 800,
        }),
      ).rejects.toBeInstanceOf(InsufficientPointsError);
      expect(fake.balanceOf(email)).toBe(100);
      expect(
        sourced(`return:${reservationId}:cs`).map((t) => t.points),
      ).toEqual([800]);
    });

    it("za mało punktów → odmowa bez zmiany salda", async () => {
      const { email } = await customer();
      await expect(
        spendLoyaltyPoints({
          email,
          reservationId: randomUUID(),
          attempt: "cs",
          points: 1001,
        }),
      ).rejects.toBeInstanceOf(InsufficientPointsError);
      expect(fake.balanceOf(email)).toBe(1000);
    });

    it("zwrot po nieukończonej płatności → punkty wracają raz, także przy ponowieniu", async () => {
      const { email } = await customer();
      const reservationId = randomUUID();
      await spendLoyaltyPoints({
        email,
        reservationId,
        attempt: "cs",
        points: 400,
      });
      expect(fake.balanceOf(email)).toBe(600);

      await expect(
        returnSpentPoints({ reservationId, attempt: "cs" }),
      ).resolves.toBe("returned");
      await expect(
        returnSpentPoints({ reservationId, attempt: "cs" }),
      ).resolves.toBe("returned");
      expect(fake.balanceOf(email)).toBe(1000);
      expect(sourced(`return:${reservationId}:cs`)).toHaveLength(1);
    });

    it("potrącenie nie zdążyło się wykonać → zwrot je anuluje, później się nie wykona", async () => {
      const { email } = await customer();
      const reservationId = randomUUID();
      fake.failures.adjust.push(
        () => new LoyaltyUnavailableError("limit", "not_applied"),
      );
      await expect(
        spendLoyaltyPoints({
          email,
          reservationId,
          attempt: "cs",
          points: 400,
        }),
      ).rejects.toThrow();

      await expect(
        returnSpentPoints({ reservationId, attempt: "cs" }),
      ).resolves.toBe("cancelled");
      await expect(
        spendLoyaltyPoints({
          email,
          reservationId,
          attempt: "cs",
          points: 400,
        }),
      ).rejects.toThrow();
      expect(fake.balanceOf(email)).toBe(1000);
    });

    it("potrącenie z nieznanym wynikiem → zwrot czeka na rozstrzygnięcie", async () => {
      const { email } = await customer();
      const reservationId = randomUUID();
      fake.failures.adjustAfterApply.push(timeout);
      await expect(
        spendLoyaltyPoints({
          email,
          reservationId,
          attempt: "cs",
          points: 400,
        }),
      ).rejects.toThrow();

      await expect(
        returnSpentPoints({ reservationId, attempt: "cs" }),
      ).rejects.toBeInstanceOf(LoyaltyUnavailableError);

      // Po rozstrzygnięciu (transakcja jest) zwrot oddaje punkty.
      const id = spendOperationId(reservationId, "cs");
      await age(id);
      await spendLoyaltyPoints({
        email,
        reservationId,
        attempt: "cs",
        points: 400,
      });
      await expect(
        returnSpentPoints({ reservationId, attempt: "cs" }),
      ).resolves.toBe("returned");
      expect(sourced(id)).toHaveLength(1);
      expect(fake.balanceOf(email)).toBe(1000);
    });
  });
});
