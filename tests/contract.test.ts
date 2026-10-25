import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getEvents } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import { POST as purchase } from "@/app/api/reservations/[id]/purchase/route";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  reservationsCollection,
} from "@/lib/db";
import type { Event } from "@/lib/schemas";

// Handlery wołamy bezpośrednio, poza requestem Next.js.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

// Testy kontraktu API — sprawdzają to, co sprawdzi nauczyciel: ścieżki,
// statusy i dokładne nazwy pól z kontraktu. Bez bazy cały plik jest pomijany.
describe.skipIf(!process.env.MONGODB_URI)("kontrakt API", () => {
  // Własny spektakl: testy nie zależą od seedu ani od danych innych osób.
  const EVENT: Event = {
    _id: `test-kontrakt-${randomUUID()}`,
    title: "Dziady",
    date: "2026-11-14",
    time: "19:00",
    stage: "Duża Scena",
  };

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  function reserve(seatId: string, overrides: Record<string, unknown> = {}) {
    return createReservation(
      new Request("http://test/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: EVENT._id,
          seatId,
          customerName: "Jan",
          email: "jan@example.com",
          ...overrides,
        }),
      }),
    );
  }

  function buy(reservationId: string) {
    return purchase(
      new Request("http://test", { method: "POST" }),
      ctx(reservationId),
    );
  }

  async function takenSeats(): Promise<string[]> {
    const res = await getEvent(new Request("http://test"), ctx(EVENT._id));
    return (await res.json()).takenSeats;
  }

  // Każdy błąd: dokładnie { error, code }, komunikat niepusty.
  async function expectError(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["code", "error"]);
    expect(json.code).toBe(code);
    expect(typeof json.error).toBe("string");
    expect(json.error.length).toBeGreaterThan(0);
  }

  beforeAll(async () => {
    await ensureIndexes();
    await eventsCollection().insertOne(EVENT);
  });

  afterAll(async () => {
    await reservationsCollection().deleteMany({ eventId: EVENT._id });
    await eventsCollection().deleteOne({ _id: EVENT._id });
    await getClient().close();
  });

  it("ścieżka główna: lista → szczegóły → rezerwacja → zakup → kod", async () => {
    // GET /api/events — lista spektakli z polami z kontraktu.
    const list = await getEvents();
    expect(list.status).toBe(200);
    const events = await list.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.find((e: Event) => e._id === EVENT._id)).toEqual(EVENT);

    // GET /api/events/:id — { event, takenSeats }, miejsce jeszcze wolne.
    const details = await getEvent(new Request("http://test"), ctx(EVENT._id));
    expect(details.status).toBe(200);
    const detailsJson = await details.json();
    expect(Object.keys(detailsJson).sort()).toEqual(["event", "takenSeats"]);
    expect(detailsJson.event).toEqual(EVENT);
    expect(detailsJson.takenSeats).not.toContain("F7");

    // POST /api/reservations — 201 { reservationId, expiresAt }.
    const reserved = await reserve("F7");
    expect(reserved.status).toBe(201);
    const reservation = await reserved.json();
    expect(Object.keys(reservation).sort()).toEqual([
      "expiresAt",
      "reservationId",
    ]);
    expect(typeof reservation.reservationId).toBe("string");
    expect(new Date(reservation.expiresAt).toISOString()).toBe(
      reservation.expiresAt,
    );
    expect(new Date(reservation.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Zarezerwowane miejsce jest w takenSeats.
    expect(await takenSeats()).toContain("F7");

    // POST /api/reservations/:id/purchase — 201 { code }.
    const bought = await buy(reservation.reservationId);
    expect(bought.status).toBe(201);
    const ticket = await bought.json();
    expect(Object.keys(ticket)).toEqual(["code"]);
    expect(ticket.code).toMatch(/^TEA-[0-9A-Z]{6}$/);

    // Kupione miejsce zostaje w takenSeats.
    expect(await takenSeats()).toContain("F7");
  });

  it("takenSeats: tablica stringów w formacie rząd A–H + fotel 1–10", async () => {
    await reserve("H10");
    const seats = await takenSeats();
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) {
      expect(seat).toMatch(/^[A-H]([1-9]|10)$/);
    }
  });

  it("expiresAt = teraz + RESERVATION_TTL_MINUTES, liczone przez serwer", async () => {
    vi.stubEnv("RESERVATION_TTL_MINUTES", "2");
    try {
      const before = Date.now();
      const res = await reserve("B2");
      const after = Date.now();
      const { expiresAt } = await res.json();
      const expires = new Date(expiresAt).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 2 * 60_000);
      expect(expires).toBeLessThanOrEqual(after + 2 * 60_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("409 SEAT_TAKEN: rezerwacja zajętego miejsca", async () => {
    expect((await reserve("C3")).status).toBe(201);
    await expectError(await reserve("C3"), 409, "SEAT_TAKEN");
  });

  it("400 VALIDATION_ERROR: błędne dane", async () => {
    await expectError(
      await reserve("C4", { email: "niemail" }),
      400,
      "VALIDATION_ERROR",
    );
    await expectError(await reserve("Z99"), 400, "VALIDATION_ERROR");
  });

  it("404 NOT_FOUND: nieistniejący spektakl i rezerwacja", async () => {
    const missingEvent = `nie-ma-${randomUUID()}`;
    await expectError(
      await getEvent(new Request("http://test"), ctx(missingEvent)),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await reserve("C5", { eventId: missingEvent }),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await buy(new ObjectId().toHexString()),
      404,
      "NOT_FOUND",
    );
    await expectError(await buy("nie-objectid"), 404, "NOT_FOUND");
  });

  it("wygaśnięcie: 410 przy zakupie, miejsce znika z takenSeats i wraca do puli", async () => {
    const { reservationId } = await (await reserve("D6")).json();
    expect(await takenSeats()).toContain("D6");

    // Nie czekamy 2 minut — przesuwamy expiresAt w przeszłość w bazie.
    await reservationsCollection().updateOne(
      { _id: new ObjectId(reservationId) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    expect(await takenSeats()).not.toContain("D6");
    await expectError(await buy(reservationId), 410, "RESERVATION_EXPIRED");

    // Bilet nie powstał, a miejsce może zarezerwować ktoś inny.
    const saved = await reservationsCollection().findOne({
      _id: new ObjectId(reservationId),
    });
    expect(saved?.code).toBeUndefined();
    expect((await reserve("D6", { customerName: "Anna" })).status).toBe(201);
  });

  it("podwójny zakup: ten sam kod, jeden bilet", async () => {
    const { reservationId } = await (await reserve("E7")).json();

    const first = await buy(reservationId);
    expect(first.status).toBe(201);
    const { code } = await first.json();

    const second = await buy(reservationId);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ code });

    expect(await reservationsCollection().countDocuments({ code })).toBe(1);
  });

  it("20 równoczesnych rezerwacji jednego miejsca → dokładnie 1 sukces", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserve("G8", { customerName: `Klient ${i}` }),
      ),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(
      await reservationsCollection().countDocuments({
        eventId: EVENT._id,
        seatId: "G8",
      }),
    ).toBe(1);
  });
});
