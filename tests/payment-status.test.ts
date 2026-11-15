import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPaymentStatus } from "@/lib/payment-status";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("oczekiwanie na płatność", () => {
  it("bez webhooka po 30 s zgłasza opóźnienie i zwalnia do 10 s", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json({ status: "held" }));
    vi.stubGlobal("fetch", fetch);
    const delayed = vi.fn();
    const update = vi.fn();
    const stop = watchPaymentStatus("abc", update, { onDelayed: delayed });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(delayed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(delayed).toHaveBeenCalledTimes(1);
    const count = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(count + 1);
    expect(update.mock.calls.every(([value]) => value.status === "held")).toBe(
      true,
    );
    stop();
  });
  it("ręczne sprawdzenie nie dubluje requestów i nie resetuje wolnego odpytywania", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json({ status: "held" }));
    vi.stubGlobal("fetch", fetch);
    const stop = watchPaymentStatus("abc", vi.fn());
    await vi.advanceTimersByTimeAsync(31_000);
    const count = fetch.mock.calls.length;
    stop.retry();
    stop.retry();
    expect(fetch).toHaveBeenCalledTimes(count + 1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(count + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(count + 2);
    stop();
  });
  it("po opóźnieniu przechodzi do paid dopiero z kodem i zatrzymuje sprawdzanie", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ status: "paid", code: " " }),
      );
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const stop = watchPaymentStatus("abc", update);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(update.mock.calls.every(([value]) => value.status === "error")).toBe(
      true,
    );
    fetch.mockResolvedValueOnce(
      Response.json({ status: "paid", code: "TEA-LATE" }),
    );
    stop.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenLastCalledWith({
      status: "paid",
      code: "TEA-LATE",
    });
    const count = fetch.mock.calls.length;
    stop.retry();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(count);
    stop();
  });
  it("przerywa zawieszone zapytanie i ponawia po błędzie", async () => {
    const fetch = vi.fn().mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const delayed = vi.fn();
    const stop = watchPaymentStatus("abc", update, { onDelayed: delayed });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(update).toHaveBeenLastCalledWith({ status: "error" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(delayed).toHaveBeenCalledTimes(1);
    stop();
  });
  it("odpytuje co 2 s, a po paid zatrzymuje się z kodem biletu", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "held" }))
      .mockResolvedValueOnce(
        Response.json({ status: "paid", code: "TEA-123" }),
      );
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const stop = watchPaymentStatus("abc", update);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenLastCalledWith({ status: "held" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(update).toHaveBeenLastCalledWith({
      status: "paid",
      code: "TEA-123",
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      "/api/reservations/abc",
      expect.objectContaining({ cache: "no-store" }),
    );
    stop();
  });
  it.each([
    [404, null, "missing"],
    [410, null, "expired"],
    [200, { status: "expired" }, "expired"],
  ])("kończy odpytywanie dla %s %j", async (status, body, expected) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const stop = watchPaymentStatus("abc", update);
    await vi.advanceTimersByTimeAsync(10000);
    expect(update).toHaveBeenCalledExactlyOnceWith({ status: expected });
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });
  it("ponawia po błędzie sieci i nie uznaje paid bez kodu za sukces", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(Response.json({ status: "paid" }))
        .mockResolvedValueOnce(
          Response.json({ status: "paid", code: "TEA-OK" }),
        ),
    );
    const update = vi.fn();
    const stop = watchPaymentStatus("abc", update);
    await vi.advanceTimersByTimeAsync(4000);
    expect(update.mock.calls.map(([state]) => state.status)).toEqual([
      "error",
      "error",
      "paid",
    ]);
    stop();
  });
  it("opuszczenie strony anuluje request i ignoruje spóźnioną odpowiedź", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const stop = watchPaymentStatus("abc", update);
    stop();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(Response.json({ status: "paid", code: "TEA-OLD" }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(update).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("czyści zaplanowane odpytywanie po opuszczeniu strony", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: "held" }));
    vi.stubGlobal("fetch", fetch);
    const stop = watchPaymentStatus("abc", vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
