import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutError, retryPayment } from "@/lib/payment-retry";

afterEach(() => vi.unstubAllGlobals());

describe("ponowna płatność", () => {
  it.each([0, 1000])(
    "wysyła tylko { points: %s }, bez kwoty dopłaty",
    async (points) => {
      const fetch = mockResponses(
        Response.json({ url: "https://checkout.stripe.com/test" }),
      );
      await retryPayment("abc", false, points);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "/api/reservations/abc/checkout",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ points }),
        },
      );
    },
  );
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "nie wysyła żądań dla błędnych punktów %s",
    async (points) => {
      const fetch = mockResponses();
      await expect(retryPayment("abc", true, points)).rejects.toThrow(
        "liczbę punktów",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([400, 409, 422])(
    "przekazuje komunikat %s o zmianie salda bez tworzenia kolejnej płatności",
    async (status) => {
      const fetch = mockResponses(
        Response.json(
          {
            code: "INSUFFICIENT_POINTS",
            error: "Saldo się zmieniło. Masz 300 punktów.",
          },
          { status },
        ),
      );
      await expect(retryPayment("abc", false, 1000)).rejects.toMatchObject({
        name: "CheckoutError",
        status,
        message: "Saldo się zmieniło. Masz 300 punktów.",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("obsługuje 4xx bez poprawnego JSON", async () => {
    mockResponses(new Response("Bad request", { status: 400 }));
    await expect(retryPayment("abc", false, 1000)).rejects.toBeInstanceOf(
      CheckoutError,
    );
  });
  it("ponowienie po anulowaniu sprawdza stan i wysyła nowy wybór punktów", async () => {
    const fetch = mockResponses(
      Response.json({ status: "held", expiresAt: "2099-01-01T00:00:00Z" }),
      Response.json({ url: "https://checkout.stripe.com/retry" }),
    );
    await expect(retryPayment("abc", true, 300)).resolves.toMatchObject({
      kind: "checkout",
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/reservations/abc", {
      cache: "no-store",
    });
    expect(fetch.mock.calls[1][1].body).toBe(JSON.stringify({ points: 300 }));
  });
  it("z punktami nadal respektuje wygaśnięcie oraz ALREADY_PAID", async () => {
    mockResponses(new Response(null, { status: 410 }));
    await expect(retryPayment("abc", false, 1000)).resolves.toEqual({
      kind: "expired",
    });
    mockResponses(
      Response.json(
        { code: "ALREADY_PAID", error: "Już opłacona" },
        { status: 409 },
      ),
      Response.json({ status: "paid", code: "TEA-123" }),
    );
    await expect(retryPayment("abc", false, 1000)).resolves.toEqual({
      kind: "paid",
      code: "TEA-123",
    });
  });
  it("pierwsza płatność wysyła POST bez kwoty z przeglądarki", async () => {
    const fetch = mockResponses(
      Response.json({ url: "https://checkout.stripe.com/test" }),
    );
    expect(await retryPayment("abc", false)).toEqual({
      kind: "checkout",
      url: "https://checkout.stripe.com/test",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/reservations/abc/checkout",
      { method: "POST" },
    );
  });
  it("pierwsza płatność po 409 odczytuje kod już kupionego biletu", async () => {
    mockResponses(
      new Response(null, { status: 409 }),
      Response.json({ status: "paid", code: "TEA-123" }),
    );
    expect(await retryPayment("abc", false)).toEqual({
      kind: "paid",
      code: "TEA-123",
    });
  });
  it.each([
    {},
    { url: "http://checkout.stripe.com/test" },
    { url: "javascript:alert(1)" },
  ])("nie przekierowuje przy błędnym URL %j", async (data) => {
    mockResponses(Response.json(data));
    await expect(retryPayment("abc", false)).rejects.toThrow();
  });
  const held = { status: "held", expiresAt: "2099-01-01T00:00:00Z" };
  function mockResponses(...responses: Response[]) {
    const fetch = vi.fn();
    for (const response of responses) fetch.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  it("sprawdza stan przed utworzeniem nowej sesji", async () => {
    const fetch = mockResponses(
      Response.json(held),
      Response.json({ url: "https://checkout.stripe.com/test" }),
    );
    expect(await retryPayment("abc")).toEqual({
      kind: "checkout",
      url: "https://checkout.stripe.com/test",
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/reservations/abc", {
      cache: "no-store",
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/reservations/abc/checkout", {
      method: "POST",
    });
  });
  it.each([
    [
      { status: "paid", code: "TEA-123" },
      { kind: "paid", code: "TEA-123" },
    ],
    [{ status: "expired" }, { kind: "expired" }],
    [{ ...held, expiresAt: "2000-01-01T00:00:00Z" }, { kind: "expired" }],
  ])(
    "nie tworzy sesji dla zakończonej rezerwacji %j",
    async (status, expected) => {
      const fetch = mockResponses(Response.json(status));
      expect(await retryPayment("abc")).toEqual(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("obsługuje wygaśnięcie między sprawdzeniem a checkoutem", async () => {
    mockResponses(Response.json(held), new Response(null, { status: 410 }));
    expect(await retryPayment("abc")).toEqual({ kind: "expired" });
  });
  it("po 409 ponownie sprawdza płatność z innej karty", async () => {
    mockResponses(
      Response.json(held),
      new Response(null, { status: 409 }),
      Response.json({ status: "paid", code: "TEA-123" }),
    );
    expect(await retryPayment("abc")).toEqual({
      kind: "paid",
      code: "TEA-123",
    });
  });
  it("nie ponawia płatności, gdy paid nie ma kodu", async () => {
    const fetch = mockResponses(Response.json({ status: "paid" }));
    await expect(retryPayment("abc")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("zgłasza niedostępność checkoutu", async () => {
    mockResponses(Response.json(held), new Response(null, { status: 503 }));
    await expect(retryPayment("abc")).rejects.toThrow(
      "Płatności chwilowo niedostępne",
    );
  });
});
