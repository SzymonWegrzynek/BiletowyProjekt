import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { WaitlistStatusContent } from "@/components/WaitlistStatus";
import { SeatMap } from "@/components/SeatMap";
import {
  eventSeats,
  joinWaitlistSchema,
  waitlistStatusSchema,
} from "@/lib/waitlist";
import {
  waitlistApi,
  watchWaitlist,
  WaitlistRequestError,
  type WaitlistApi,
} from "@/lib/waitlist-client";
import { STUB_WAITLIST_EVENT, STUB_WAITLIST_STATUS } from "@/lib/stubs";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const id = "6740c0ffee00000000000001";
const api = (): WaitlistApi => ({
  join: vi.fn(),
  read: vi.fn(async () => STUB_WAITLIST_STATUS.waiting),
  leave: vi.fn(),
  ticket: vi.fn(),
});

it("renderuje dwa miejsca z planu i Powiadom mnie przy soldOut", () => {
  const html = renderToStaticMarkup(
    createElement(SeatMap, {
      event: STUB_WAITLIST_EVENT,
      takenSeats: ["A1", "A2"],
      soldOut: true,
    }),
  );
  expect((html.match(/aria-pressed=/g) ?? []).length).toBe(2);
  expect(html).toContain("Powiadom mnie");
  expect(html).not.toContain("Rząd B");
  expect(eventSeats({})).toHaveLength(80);
  expect(() => eventSeats({ seats: ["A1", "A1"] })).toThrow();
});
it("wolne wydarzenie nie proponuje zapisu na kolejkę", () => {
  const html = renderToStaticMarkup(
    createElement(SeatMap, {
      event: STUB_WAITLIST_EVENT,
      takenSeats: [],
      soldOut: false,
    }),
  );
  expect(html).not.toContain("Powiadom mnie");
  expect(html).toContain("Wybierz wolny fotel");
});
it.each(["waiting", "offered", "done", "missed", "left"] as const)(
  "wyświetla stan %s bez obietnicy biletu",
  (status) => {
    const html = renderToStaticMarkup(
      createElement(WaitlistStatusContent, {
        state: STUB_WAITLIST_STATUS[status],
        now: Date.parse("2026-12-15T17:14:00Z"),
      }),
    );
    expect(html).not.toContain("Zobacz bilet");
    if (status === "waiting") expect(html).toContain("aktualna pozycja");
    if (status === "offered") {
      expect(html).toContain("1:00");
      expect(html).toContain("Rząd A, miejsce 1");
      expect(html).toContain("/rezerwacja/");
    }
    if (status === "missed") expect(html).toContain("miejsce przeszło dalej");
    if (status === "left") expect(html).toContain("Wypisano");
  },
);
it("po czasie oferty nie renderuje linku do płatności", () => {
  const html = renderToStaticMarkup(
    createElement(WaitlistStatusContent, {
      state: STUB_WAITLIST_STATUS.offered,
      now: Date.parse(STUB_WAITLIST_STATUS.offered.offerExpiresAt),
    }),
  );
  expect(html).not.toContain('href="/rezerwacja/');
  expect(html).toContain("Czas oferty minął");
});
it("sprawdza imię, e-mail i nie przyjmuje oferty bez id/czasu", () => {
  expect(
    joinWaitlistSchema.safeParse({ customerName: " ", email: "bad" }).success,
  ).toBe(false);
  expect(
    waitlistStatusSchema.safeParse({ status: "offered", position: 0 }).success,
  ).toBe(false);
  expect(
    waitlistStatusSchema.safeParse({ status: "waiting", position: 0 }).success,
  ).toBe(false);
});
it("POST zawiera tylko dane zapisu, URL nie zawiera e-maila; DELETE akceptuje 204", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ waitlistId: id, position: 1 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  await waitlistApi.join("waitlist-test", {
    customerName: "Ola",
    email: "delivered@resend.dev",
  });
  expect(fetch.mock.calls[0][0]).toBe("/api/events/waitlist-test/waitlist");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    customerName: "Ola",
    email: "delivered@resend.dev",
  });
  await expect(waitlistApi.leave(id)).resolves.toBeUndefined();
});
it("odświeża pozycję co 5 s i przestaje po wypisaniu", async () => {
  vi.useFakeTimers();
  const transport = api();
  vi.mocked(transport.read)
    .mockResolvedValueOnce({ status: "waiting", position: 3 })
    .mockResolvedValueOnce({ status: "waiting", position: 2 })
    .mockResolvedValueOnce({ status: "left", position: 0 });
  const update = vi.fn();
  const watcher = watchWaitlist(id, update, transport);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(update.mock.calls.map(([value]) => value.position)).toEqual([3, 2, 0]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(transport.read).toHaveBeenCalledTimes(3);
  watcher.stop();
});
it("bilet pokazuje wyłącznie po potwierdzonym paid z kodem", async () => {
  vi.useFakeTimers();
  const transport = api();
  vi.mocked(transport.read).mockResolvedValue(STUB_WAITLIST_STATUS.done);
  vi.mocked(transport.ticket)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("TEA-OK");
  const update = vi.fn();
  const watcher = watchWaitlist(id, update, transport);
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenLastCalledWith(STUB_WAITLIST_STATUS.done);
  await vi.advanceTimersByTimeAsync(5000);
  expect(update).toHaveBeenLastCalledWith({ status: "ticket", code: "TEA-OK" });
  watcher.stop();
});
it("odczyt ticket nie przyjmuje paid bez kodu ani held z kodem", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: "paid", code: " " }))
    .mockResolvedValueOnce(Response.json({ status: "held", code: "TEA-FAKE" }));
  vi.stubGlobal("fetch", fetch);
  expect(await waitlistApi.ticket(id, new AbortController().signal)).toBeNull();
  expect(await waitlistApi.ticket(id, new AbortController().signal)).toBeNull();
});
it("nie nakłada zapytań i ignoruje spóźniony GET po stop/DELETE", async () => {
  vi.useFakeTimers();
  const transport = api();
  let resolve!: (value: typeof STUB_WAITLIST_STATUS.waiting) => void;
  vi.mocked(transport.read).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const update = vi.fn();
  const watcher = watchWaitlist(id, update, transport);
  watcher.refresh();
  watcher.refresh();
  expect(transport.read).toHaveBeenCalledTimes(1);
  watcher.stop();
  resolve(STUB_WAITLIST_STATUS.waiting);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(update).not.toHaveBeenCalled();
});
it("timeout nie zawiesza odświeżania; 404 kończy sprawdzanie", async () => {
  vi.useFakeTimers();
  const transport = api();
  vi.mocked(transport.read)
    .mockImplementationOnce(
      (_id, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("timeout"))),
        ),
    )
    .mockRejectedValueOnce(new WaitlistRequestError(404, "NOT_FOUND", "brak"));
  const update = vi.fn();
  const watcher = watchWaitlist(id, update, transport);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(update).toHaveBeenLastCalledWith({ status: "error" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(update).toHaveBeenLastCalledWith({ status: "missing" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(transport.read).toHaveBeenCalledTimes(2);
  watcher.stop();
});
