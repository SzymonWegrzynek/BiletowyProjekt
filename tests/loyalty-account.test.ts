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
} from "@/lib/db";
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
});

const DOMAIN = "loyalty-account.test";
const newEmail = () => `klient-${randomUUID()}@${DOMAIN}`;

function getBalance(email: string | null) {
  const url = new URL("http://test/api/loyalty");
  if (email !== null) url.searchParams.set("email", email);
  return GET(new Request(url));
}

describe("GET /api/loyalty — walidacja (bez bazy)", () => {
  it("brak e-maila → 400 VALIDATION_ERROR", async () => {
    const res = await getBalance(null);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(voucherify.join).not.toHaveBeenCalled();
  });

  it("niepoprawny e-mail → 400 z komunikatem po polsku", async () => {
    const res = await getBalance("to-nie-mail");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Niepoprawny adres e-mail",
      code: "VALIDATION_ERROR",
    });
  });
});

describe.skipIf(!process.env.MONGODB_URI)("GET /api/loyalty", () => {
  beforeAll(async () => {
    await ensureIndexes();
  });

  afterAll(async () => {
    const mine = { $regex: `@${DOMAIN.replace(".", "\\.")}$` };
    await loyaltyAccountsCollection().deleteMany({ _id: mine });
    await loyaltyOperationsCollection().deleteMany({ email: mine });
    await getClient().close();
  });

  it("nowy klient → 1000 punktów, jedna karta, jeden bonus", async () => {
    const email = newEmail();
    const res = await getBalance(email);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ email, points: 1000 });

    expect(voucherify.join).toHaveBeenCalledTimes(1);
    expect(fake.transactions).toEqual([
      expect.objectContaining({ points: 1000, sourceId: `bonus:${email}` }),
    ]);
    const operation = await loyaltyOperationsCollection().findOne({
      _id: `bonus:${email}`,
    });
    expect(operation).toMatchObject({ status: "done", points: 1000 });
    const account = await loyaltyAccountsCollection().findOne({ _id: email });
    expect(account?.cardCode).toBe(fake.cardOf(email));
  });

  it("kolejne odczyty nie przyznają bonusu drugi raz, saldo z Voucherify", async () => {
    const email = newEmail();
    await getBalance(email);
    const second = await getBalance(email);
    const third = await getBalance(email);

    expect(await second.json()).toEqual({ email, points: 1000 });
    expect(await third.json()).toEqual({ email, points: 1000 });
    expect(fake.transactions).toHaveLength(1);
    expect(voucherify.join).toHaveBeenCalledTimes(1);
    expect(voucherify.get).toHaveBeenCalledTimes(2);
  });

  it("e-mail wielkimi literami i ze spacjami → to samo konto", async () => {
    const email = newEmail();
    await getBalance(email);
    const res = await getBalance(`  ${email.toUpperCase()} `);
    expect(await res.json()).toEqual({ email, points: 1000 });
    expect(fake.transactions).toHaveLength(1);
  });

  it("saldo zmienione poza aplikacją → odczyt pokazuje aktualne", async () => {
    const email = newEmail();
    await getBalance(email);
    fake.setBalance(email, 2750);
    const res = await getBalance(email);
    expect(await res.json()).toEqual({ email, points: 2750 });
  });

  it("Voucherify nie odpowiada przy odczycie → 503, nie saldo 0", async () => {
    const email = newEmail();
    await getBalance(email);
    fake.failures.get.push(
      () => new LoyaltyUnavailableError("timeout", "unknown"),
    );
    const res = await getBalance(email);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await res.json()).toMatchObject({ code: "LOYALTY_UNAVAILABLE" });
  });

  it("Voucherify niedostępny przy dołączaniu → 503, konto bez karty", async () => {
    const email = newEmail();
    fake.failures.join.push(
      () => new LoyaltyUnavailableError("limit", "not_applied", 30),
    );
    const res = await getBalance(email);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const account = await loyaltyAccountsCollection().findOne({ _id: email });
    expect(account?.cardCode).toBeUndefined();
    // Dołączanie zwolnione — następny odczyt może spróbować od razu.
    expect(account?.joinLeaseUntil).toBeUndefined();

    const retried = await getBalance(email);
    expect(await retried.json()).toEqual({ email, points: 1000 });
  });

  it("bonus nie przeszedł → 503; następny odczyt go dokańcza, raz", async () => {
    const email = newEmail();
    fake.failures.adjust.push(
      () => new LoyaltyUnavailableError("limit", "not_applied"),
    );
    const failed = await getBalance(email);
    expect(failed.status).toBe(503);
    expect(fake.transactions).toHaveLength(0);
    expect(
      await loyaltyOperationsCollection().findOne({ _id: `bonus:${email}` }),
    ).toMatchObject({ status: "pending", attempts: 1 });

    const retried = await getBalance(email);
    expect(await retried.json()).toEqual({ email, points: 1000 });
    expect(fake.transactions).toHaveLength(1);
  });
});
