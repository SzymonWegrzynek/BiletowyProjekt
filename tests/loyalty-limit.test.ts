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
import { GET } from "@/app/api/loyalty/route";
import {
  ensureIndexes,
  getClient,
  loyaltyAccountsCollection,
  loyaltyOperationsCollection,
  rateLimitsCollection,
} from "@/lib/db";
import { getBalanceCacheMs } from "@/lib/loyalty-account";
import { applyLoyaltyOperation } from "@/lib/loyalty-operations";
import { getLoyaltyRateLimit } from "@/lib/rate-limit";
import {
  createFakeVoucherify,
  type FakeVoucherify,
} from "./fixtures/fake-voucherify";

// Voucherify w testach jest zamockowany — żadnych prawdziwych zapytań.
const voucherify = vi.hoisted(() => ({
  join: vi.fn(),
  get: vi.fn(),
  adjust: vi.fn(),
}));

vi.mock("@/lib/voucherify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voucherify")>()),
  joinLoyaltyProgram: (...args: unknown[]) => voucherify.join(...args),
  getLoyaltyCard: (...args: unknown[]) => voucherify.get(...args),
  adjustLoyaltyBalance: (...args: unknown[]) => voucherify.adjust(...args),
}));

let fake: FakeVoucherify;

beforeEach(() => {
  fake = createFakeVoucherify();
  voucherify.join.mockReset().mockImplementation(fake.join);
  voucherify.get.mockReset().mockImplementation(fake.get);
  voucherify.adjust.mockReset().mockImplementation(fake.adjust);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function getBalance(email: string, ip?: string) {
  const url = new URL("http://test/api/loyalty");
  url.searchParams.set("email", email);
  return GET(
    new Request(url, ip ? { headers: { "x-forwarded-for": ip } } : {}),
  );
}

describe("konfiguracja limitu i kopii salda (bez bazy)", () => {
  it("LOYALTY_RATE_LIMIT: domyślnie 10, odrzuca złe wartości", () => {
    vi.stubEnv("LOYALTY_RATE_LIMIT", undefined);
    expect(getLoyaltyRateLimit()).toBe(10);
    vi.stubEnv("LOYALTY_RATE_LIMIT", "25");
    expect(getLoyaltyRateLimit()).toBe(25);
    vi.stubEnv("LOYALTY_RATE_LIMIT", "0");
    expect(() => getLoyaltyRateLimit()).toThrow();
    vi.stubEnv("LOYALTY_RATE_LIMIT", "abc");
    expect(() => getLoyaltyRateLimit()).toThrow();
  });

  it("LOYALTY_BALANCE_CACHE_SECONDS: domyślnie 15 s, 0 wyłącza, ujemne błąd", () => {
    vi.stubEnv("LOYALTY_BALANCE_CACHE_SECONDS", undefined);
    expect(getBalanceCacheMs()).toBe(15_000);
    vi.stubEnv("LOYALTY_BALANCE_CACHE_SECONDS", "0");
    expect(getBalanceCacheMs()).toBe(0);
    vi.stubEnv("LOYALTY_BALANCE_CACHE_SECONDS", "-1");
    expect(() => getBalanceCacheMs()).toThrow();
  });
});

describe.skipIf(!process.env.MONGODB_URI)(
  "zalew odczytów salda (III.A3)",
  () => {
    const DOMAIN = "loyalty-limit.test";
    const RUN = randomUUID();
    const newEmail = () => `klient-${randomUUID()}@${DOMAIN}`;
    // Unikalne „IP” na uruchomienie: liczniki z poprzednich przebiegów nie przeszkadzają.
    const flooder = `flood-${RUN}`;
    const otherClient = `other-${RUN}`;
    const LIMIT = 3;

    beforeAll(async () => {
      await ensureIndexes();
    });

    afterAll(async () => {
      const mine = { $regex: `@${DOMAIN.replace(".", "\\.")}$` };
      await loyaltyAccountsCollection().deleteMany({ _id: mine });
      await loyaltyOperationsCollection().deleteMany({ email: mine });
      await rateLimitsCollection().deleteMany({ _id: { $regex: RUN } });
      await getClient().close();
    });

    it("jeden klient odpytuje saldo w pętli → 429 z Retry-After; drugi klient widzi saldo", async () => {
      vi.stubEnv("LOYALTY_RATE_LIMIT", String(LIMIT));
      vi.stubEnv("LOYALTY_BALANCE_CACHE_SECONDS", "60");
      const flooderEmail = newEmail();

      // 2 × limit + 1: nawet gdy w trakcie zacznie się nowe okno 10 s,
      // przynajmniej jedno zapytanie musi dostać 429.
      const responses = [];
      for (let i = 0; i < 2 * LIMIT + 1; i++) {
        responses.push(await getBalance(flooderEmail, flooder));
      }
      const limited = responses.filter((res) => res.status === 429);
      expect(limited.length).toBeGreaterThanOrEqual(1);
      for (const res of limited) {
        expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(
          1,
        );
        expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" });
      }
      for (const res of responses.filter((r) => r.status !== 429)) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ email: flooderEmail, points: 1000 });
      }
      // Zalew nie przełożył się na zapytania do Voucherify: dołączenie, bonus
      // i najwyżej jeden odczyt salda — resztę obsłużyła kopia albo limit.
      expect(voucherify.join).toHaveBeenCalledTimes(1);
      expect(voucherify.adjust).toHaveBeenCalledTimes(1);
      expect(voucherify.get.mock.calls.length).toBeLessThanOrEqual(1);

      // Drugi klient z innej sieci normalnie sprawdza saldo.
      const otherEmail = newEmail();
      const other = await getBalance(otherEmail, otherClient);
      expect(other.status).toBe(200);
      expect(await other.json()).toEqual({ email: otherEmail, points: 1000 });
    });

    it("kopia salda: kolejne odczyty bez Voucherify, zmiana przez aplikację od razu widoczna", async () => {
      vi.stubEnv("LOYALTY_BALANCE_CACHE_SECONDS", "60");
      const email = newEmail();
      await getBalance(email); // dołączenie + bonus (saldo z odpowiedzi bonusu)

      expect(await (await getBalance(email)).json()).toMatchObject({
        points: 1000,
      });
      expect(voucherify.get).toHaveBeenCalledTimes(1);
      await getBalance(email);
      expect(voucherify.get).toHaveBeenCalledTimes(1); // z kopii

      // Zmiana w innym kanale: widoczna dopiero po wygaśnięciu kopii.
      fake.setBalance(email, 2000);
      expect(await (await getBalance(email)).json()).toMatchObject({
        points: 1000,
      });

      // Zmiana przez aplikację (np. nagroda za zakup) unieważnia kopię.
      const cardCode = fake.cardOf(email);
      if (!cardCode) throw new Error("brak karty w atrapie");
      await applyLoyaltyOperation({
        id: `earn:test-${randomUUID()}`,
        email,
        cardCode,
        points: 50,
        reason: "test",
      });
      expect(await (await getBalance(email)).json()).toMatchObject({
        points: 2050,
      });
      expect(voucherify.get).toHaveBeenCalledTimes(2);
    });

    it("odczyt sprzed zmiany salda nie nadpisuje unieważnienia kopii", async () => {
      vi.stubEnv("LOYALTY_BALANCE_CACHE_SECONDS", "60");
      const email = newEmail();
      await getBalance(email);

      // W trakcie odczytu z Voucherify aplikacja zmienia saldo (wersja rośnie).
      voucherify.get.mockImplementationOnce(async (cardCode: string) => {
        const before = await fake.get(cardCode);
        await loyaltyAccountsCollection().updateOne(
          { _id: email },
          { $inc: { balanceVersion: 1 } },
        );
        return before;
      });
      await getBalance(email);

      const account = await loyaltyAccountsCollection().findOne({ _id: email });
      expect(account?.balance).toBeUndefined();
      await getBalance(email);
      expect(voucherify.get).toHaveBeenCalledTimes(2); // nie z kopii
    });
  },
);
