import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createReservation } from "@/app/api/reservations/route";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  reservationsCollection,
} from "@/lib/db";
import type { Reservation } from "@/lib/schemas";

function postJson(body: unknown) {
  return new Request("http://test/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Walidacja odpada przed zapytaniem do bazy, więc działa także bez MONGODB_URI.
describe("POST /api/reservations — walidacja", () => {
  const valid = {
    eventId: "dowolny",
    seatId: "B3",
    customerName: "Jan",
    email: "jan@example.com",
  };

  it.each([
    ["zły e-mail", { ...valid, email: "niemail" }],
    ["puste imię", { ...valid, customerName: "  " }],
    ["miejsce spoza widowni", { ...valid, seatId: "Z99" }],
    ["fotel 11", { ...valid, seatId: "A11" }],
    ["brak pola", { seatId: "B3" }],
    ["brak body", null],
  ])("400 VALIDATION_ERROR: %s", async (_name, body) => {
    const res = await createReservation(postJson(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_ERROR");
    expect(json.error).not.toMatch(/Invalid|expected/);
  });
});

describe.skipIf(!process.env.MONGODB_URI)("POST /api/reservations", () => {
  // Własny spektakl na każde uruchomienie: testy nie zależą od seedu
  // ani od danych innych osób na teatr-test.
  const eventId = `test-rezerwacja-${randomUUID()}`;
  const reservations = () => reservationsCollection();

  function body(seatId: string) {
    return {
      eventId,
      seatId,
      customerName: "Jan",
      email: "jan@example.com",
    };
  }

  // Inny klient na to samo miejsce.
  function otherCustomer(seatId: string, i = 0) {
    return {
      ...body(seatId),
      customerName: `Klient ${i}`,
      email: `klient${i}@example.com`,
    };
  }

  function existing(
    seatId: string,
    status: Reservation["status"],
    expiresAt: Date,
  ): Reservation {
    return {
      _id: new ObjectId(),
      ...body(seatId),
      status,
      expiresAt,
      createdAt: new Date(),
      ...(status === "purchased" && { code: `TEA-${randomUUID()}` }),
    };
  }

  beforeAll(async () => {
    await ensureIndexes();
    await eventsCollection().insertOne({
      _id: eventId,
      title: "Test",
      date: "2026-11-14",
      time: "19:00",
      stage: "Duża Scena",
    });
  });

  afterAll(async () => {
    await reservations().deleteMany({ eventId });
    await eventsCollection().deleteOne({ _id: eventId });
    await getClient().close();
  });

  it("201: zapisuje rezerwację held i zwraca reservationId + expiresAt", async () => {
    const before = Date.now();
    const res = await createReservation(postJson(body("A1")));
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["expiresAt", "reservationId"]);
    expect(json.reservationId).toMatch(/^[0-9a-f]{24}$/);
    expect(new Date(json.expiresAt).toISOString()).toBe(json.expiresAt);

    const saved = await reservations().findOne({
      _id: new ObjectId(json.reservationId),
    });
    expect(saved).toMatchObject({
      eventId,
      seatId: "A1",
      status: "held",
    });
    expect(saved?.code).toBeUndefined();
    // Czas liczy serwer: expiresAt = createdAt + TTL.
    expect(saved!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved!.expiresAt.toISOString()).toBe(json.expiresAt);
  });

  it("409 SEAT_TAKEN: miejsce z ważną rezerwacją innego klienta", async () => {
    await createReservation(postJson(body("A2")));
    const res = await createReservation(postJson(otherCustomer("A2")));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SEAT_TAKEN");
  });

  it("idempotentność: ten sam request 2× po kolei → ta sama rezerwacja", async () => {
    const first = await createReservation(postJson(body("B1")));
    expect(first.status).toBe(201);
    const firstJson = await first.json();

    const second = await createReservation(postJson(body("B1")));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstJson);

    expect(await reservations().countDocuments({ eventId, seatId: "B1" })).toBe(
      1,
    );
  });

  it("idempotentność: 20 identycznych requestów równolegle → jedna rezerwacja", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => createReservation(postJson(body("B2")))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(19);

    const ids = new Set(
      await Promise.all(
        responses.map(async (r) => (await r.json()).reservationId),
      ),
    );
    expect(ids.size).toBe(1);
    expect(await reservations().countDocuments({ eventId, seatId: "B2" })).toBe(
      1,
    );
  });

  it("idempotentność nie dotyczy kupionego miejsca: ten sam klient → 409", async () => {
    await reservations().insertOne(
      existing("B3", "purchased", new Date(Date.now() + 60_000)),
    );
    const res = await createReservation(postJson(body("B3")));
    expect(res.status).toBe(409);
  });

  it("409 SEAT_TAKEN: miejsce kupione, nawet z dawnym expiresAt", async () => {
    await reservations().insertOne(
      existing("A3", "purchased", new Date(Date.now() - 3_600_000)),
    );
    const res = await createReservation(postJson(body("A3")));
    expect(res.status).toBe(409);
  });

  it("201: wygasła rezerwacja nie blokuje miejsca i znika z bazy", async () => {
    const expired = existing("A4", "held", new Date(Date.now() - 60_000));
    await reservations().insertOne(expired);

    const res = await createReservation(postJson(body("A4")));
    expect(res.status).toBe(201);
    expect(await reservations().findOne({ _id: expired._id })).toBeNull();
    expect(await reservations().countDocuments({ eventId, seatId: "A4" })).toBe(
      1,
    );
  });

  it("404 NOT_FOUND: nie ma takiego spektaklu", async () => {
    const res = await createReservation(
      postJson({ ...body("A5"), eventId: `nie-ma-${randomUUID()}` }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("20 równoczesnych rezerwacji jednego miejsca = dokładnie 1 sukces", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createReservation(postJson(otherCustomer("H10", i))),
      ),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(
      await reservations().countDocuments({ eventId, seatId: "H10" }),
    ).toBe(1);
  });

  it("20 równoczesnych rezerwacji miejsca po wygasłej = dokładnie 1 sukces", async () => {
    await reservations().insertOne(
      existing("H9", "held", new Date(Date.now() - 60_000)),
    );
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createReservation(postJson(otherCustomer("H9", i))),
      ),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(await reservations().countDocuments({ eventId, seatId: "H9" })).toBe(
      1,
    );
  });
});
