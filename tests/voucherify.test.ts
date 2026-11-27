import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LoyaltyUnavailableError,
  VoucherifyRequestError,
  adjustLoyaltyBalance,
  getLoyaltyCard,
  joinLoyaltyProgram,
} from "@/lib/voucherify";

// Adapter Voucherify na podmienionym fetch — bez sieci i bez bazy.
const fetchMock = vi.fn();

function json(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const MEMBER = {
  code: "LC-ABC",
  loyalty_card: { points: 1500, balance: 1200 },
};

beforeEach(() => {
  vi.stubEnv("VOUCHERIFY_APP_ID", "app-id");
  vi.stubEnv("VOUCHERIFY_SECRET_KEY", "secret");
  vi.stubEnv("VOUCHERIFY_CAMPAIGN_ID", "camp_1");
  vi.stubEnv("VOUCHERIFY_API_URL", "https://vf.test/");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adapter Voucherify", () => {
  it("dołączenie do programu: POST members z e-mailem jako source_id", async () => {
    fetchMock.mockResolvedValue(json(200, MEMBER));
    await expect(joinLoyaltyProgram("jan@example.com")).resolves.toEqual({
      cardCode: "LC-ABC",
      balance: 1200,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://vf.test/v1/loyalties/camp_1/members");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-App-Id": "app-id",
      "X-App-Token": "secret",
    });
    expect(JSON.parse(init.body)).toEqual({
      customer: { source_id: "jan@example.com", email: "jan@example.com" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("odczyt karty: saldo = loyalty_card.balance (dostępne punkty)", async () => {
    fetchMock.mockResolvedValue(json(200, MEMBER));
    await expect(getLoyaltyCard("LC-ABC")).resolves.toEqual({
      cardCode: "LC-ABC",
      balance: 1200,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://vf.test/v1/loyalties/camp_1/members/LC-ABC",
    );
  });

  it("zmiana salda: punkty, source_id = id operacji, saldo po zmianie", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        points: 500,
        total: 1700,
        balance: 1700,
        type: "loyalty_card",
      }),
    );
    await expect(
      adjustLoyaltyBalance("LC-ABC", 500, {
        sourceId: "earn:abc",
        reason: "Nagroda",
      }),
    ).resolves.toEqual({ balance: 1700 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://vf.test/v1/loyalties/camp_1/members/LC-ABC/balance",
    );
    expect(JSON.parse(init.body)).toEqual({
      points: 500,
      source_id: "earn:abc",
      reason: "Nagroda",
    });
  });

  it("brak konfiguracji → niedostępne, na pewno bez zmiany (not_applied)", async () => {
    vi.stubEnv("VOUCHERIFY_SECRET_KEY", "");
    const error = await getLoyaltyCard("LC-ABC").catch((e) => e);
    expect(error).toBeInstanceOf(LoyaltyUnavailableError);
    expect(error.outcome).toBe("not_applied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("timeout / zerwane połączenie → niedostępne, wynik nieznany", async () => {
    fetchMock.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    const error = await adjustLoyaltyBalance("LC-ABC", 500, {
      sourceId: "earn:abc",
      reason: "Nagroda",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LoyaltyUnavailableError);
    expect(error.outcome).toBe("unknown");
  });

  it("429 → niedostępne, not_applied, z Retry-After", async () => {
    fetchMock.mockResolvedValue(json(429, {}, { "Retry-After": "30" }));
    const error = await getLoyaltyCard("LC-ABC").catch((e) => e);
    expect(error).toBeInstanceOf(LoyaltyUnavailableError);
    expect(error.outcome).toBe("not_applied");
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("5xx → niedostępne, wynik nieznany", async () => {
    fetchMock.mockResolvedValue(json(502, { message: "bad gateway" }));
    const error = await getLoyaltyCard("LC-ABC").catch((e) => e);
    expect(error).toBeInstanceOf(LoyaltyUnavailableError);
    expect(error.outcome).toBe("unknown");
  });

  it("401 (zły klucz) → niedostępne, not_applied", async () => {
    fetchMock.mockResolvedValue(json(401, { key: "unauthorized" }));
    const error = await getLoyaltyCard("LC-ABC").catch((e) => e);
    expect(error).toBeInstanceOf(LoyaltyUnavailableError);
    expect(error.outcome).toBe("not_applied");
  });

  it("inne 4xx → VoucherifyRequestError ze statusem i kluczem", async () => {
    fetchMock.mockResolvedValue(
      json(404, { key: "not_found", message: "Resource not found" }),
    );
    const error = await getLoyaltyCard("LC-XXX").catch((e) => e);
    expect(error).toBeInstanceOf(VoucherifyRequestError);
    expect(error.status).toBe(404);
    expect(error.key).toBe("not_found");
  });

  it("nieoczekiwany kształt karty → niedostępne, nie saldo 0", async () => {
    fetchMock.mockResolvedValue(json(200, { code: "LC-ABC" }));
    await expect(getLoyaltyCard("LC-ABC")).rejects.toBeInstanceOf(
      LoyaltyUnavailableError,
    );
  });
});
