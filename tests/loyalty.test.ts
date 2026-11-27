import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLoyaltyBalance } from "@/lib/loyalty";
import { GET } from "@/app/api/loyalty/route";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("saldo punktów", () => {
  it("nie odpytuje dla niepoprawnego adresu ani podczas pisania", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    loadLoyaltyBalance("nie-email", vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const stop = loadLoyaltyBalance("a@example.com", vi.fn());
    await vi.advanceTimersByTimeAsync(399);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("po 400 ms pobiera saldo dla znormalizowanego adresu, bez cyklicznego odpytywania", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ email: "a+test@example.com", points: 1000 }),
      );
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const stop = loadLoyaltyBalance(" A+test@EXAMPLE.com ", update);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetch).toHaveBeenCalledWith(
      "/api/loyalty?email=a%2Btest%40example.com",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(update).toHaveBeenLastCalledWith({ status: "ready", points: 1000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each(["success", "error"])(
    "odrzuca spóźnione %s starego adresu nawet gdy fetch ignoruje abort",
    async (result) => {
      let resolveOld!: (response: Response) => void;
      let rejectOld!: (error: Error) => void;
      const fetch = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve, reject) => {
              resolveOld = resolve;
              rejectOld = reject;
            }),
        )
        .mockResolvedValueOnce(
          Response.json({ email: "b@example.com", points: 73 }),
        );
      vi.stubGlobal("fetch", fetch);
      const oldUpdate = vi.fn();
      const stopOld = loadLoyaltyBalance("a@example.com", oldUpdate);
      await vi.advanceTimersByTimeAsync(400);
      stopOld();
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
      const update = vi.fn();
      const stop = loadLoyaltyBalance("b@example.com", update);
      await vi.advanceTimersByTimeAsync(400);
      if (result === "success")
        resolveOld(Response.json({ email: "a@example.com", points: 999 }));
      else rejectOld(new Error("offline"));
      await vi.advanceTimersByTimeAsync(0);
      expect(oldUpdate).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledExactlyOnceWith({
        status: "ready",
        points: 73,
      });
      stop();
    },
  );

  it.each([
    { email: "other@example.com", points: 1000 },
    { email: "a@example.com", points: -1 },
    { email: "a@example.com", points: 1.5 },
    { email: "a@example.com", points: "1000" },
    null,
  ])("odrzuca niepoprawne dane odpowiedzi %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    const update = vi.fn();
    const stop = loadLoyaltyBalance("a@example.com", update);
    await vi.advanceTimersByTimeAsync(400);
    expect(update).toHaveBeenCalledExactlyOnceWith({ status: "error" });
    stop();
  });

  it("obsługuje 503 i pozwala ponowić odczyt z saldem zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "awaria" }, { status: 503 }),
        )
        .mockResolvedValueOnce(
          Response.json({ email: "a@example.com", points: 0 }),
        ),
    );
    const update = vi.fn();
    const stop = loadLoyaltyBalance("a@example.com", update);
    await vi.advanceTimersByTimeAsync(400);
    expect(update).toHaveBeenLastCalledWith({ status: "error" });
    stop();
    const retry = loadLoyaltyBalance("a@example.com", update);
    await vi.advanceTimersByTimeAsync(400);
    expect(update).toHaveBeenLastCalledWith({ status: "ready", points: 0 });
    retry();
  });

  it("kończy zawieszone zapytanie po 10 s i ignoruje późny wynik", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const update = vi.fn();
    const stop = loadLoyaltyBalance("a@example.com", update);
    await vi.advanceTimersByTimeAsync(10_400);
    expect(update).toHaveBeenCalledExactlyOnceWith({ status: "error" });
    resolve(Response.json({ email: "a@example.com", points: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    stop();
  });
});

// Saldo i bonus 1000 testuje backend A (tests/loyalty-account.test.ts) na
// atrapie Voucherify — tu zostaje walidacja wejścia.
describe("GET loyalty — walidacja", () => {
  it.each(["", "?email=abc"])(
    "odrzuca brak lub niepoprawny adres: %s",
    async (query) => {
      expect(
        (await GET(new Request(`http://test/api/loyalty${query}`))).status,
      ).toBe(400);
    },
  );
});
