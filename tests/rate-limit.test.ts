import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { POST as createReservation } from "@/app/api/reservations/route";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  rateLimitsCollection,
  reservationsCollection,
} from "@/lib/db";
import { clientIp, getReservationRateLimit } from "@/lib/rate-limit";

function reserveFrom(ip: string, body: unknown) {
  return createReservation(
    new Request("http://test/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

describe("clientIp", () => {
  const withHeaders = (headers: Record<string, string>) =>
    clientIp(new Request("http://test", { headers }));

  it("bierze x-real-ip, potem pierwszy adres z x-forwarded-for", () => {
    expect(withHeaders({ "x-real-ip": "1.1.1.1" })).toBe("1.1.1.1");
    expect(withHeaders({ "x-forwarded-for": "2.2.2.2, 10.0.0.1" })).toBe(
      "2.2.2.2",
    );
    expect(withHeaders({})).toBe("unknown");
  });
});

describe("getReservationRateLimit", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("czyta RESERVATION_RATE_LIMIT i odrzuca złe wartości", () => {
    vi.stubEnv("RESERVATION_RATE_LIMIT", "7");
    expect(getReservationRateLimit()).toBe(7);
    vi.stubEnv("RESERVATION_RATE_LIMIT", "0");
    expect(() => getReservationRateLimit()).toThrow();
  });
});

describe.skipIf(!process.env.MONGODB_URI)("limit rezerwacji (429)", () => {
  const eventId = `test-limit-${randomUUID()}`;
  // Unikalne „IP” na uruchomienie: liczniki z poprzednich przebiegów nie przeszkadzają.
  const flooder = `flood-${randomUUID()}`;
  const otherClient = `other-${randomUUID()}`;
  const LIMIT = 5;

  const body = (seatId: string, customerName = "Jan") => ({
    eventId,
    seatId,
    customerName,
    email: "jan@example.com",
  });

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

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await reservationsCollection().deleteMany({ eventId });
    await eventsCollection().deleteOne({ _id: eventId });
    await rateLimitsCollection().deleteMany({
      _id: { $regex: `^reservations:(${flooder}|${otherClient}):` },
    });
    await getClient().close();
  });

  it("zalewający klient dostaje 429 z Retry-After, drugi rezerwuje bez problemu", async () => {
    vi.stubEnv("RESERVATION_RATE_LIMIT", String(LIMIT));

    // Jak w ataku: dużo rezerwacji różnych miejsc naraz z jednego IP.
    const seats = ["A", "B", "C"].flatMap((row) =>
      Array.from({ length: 4 }, (_, i) => `${row}${i + 1}`),
    );
    const responses = await Promise.all(
      seats.map((seat) => reserveFrom(flooder, body(seat))),
    );
    const statuses = responses.map((r) => r.status);

    // Okno 10 s może się zmienić w trakcie — wtedy przejdzie najwyżej 2 × LIMIT.
    const passed = statuses.filter((s) => s === 201).length;
    expect(passed).toBeGreaterThanOrEqual(LIMIT);
    expect(passed).toBeLessThanOrEqual(2 * LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(
      seats.length - passed,
    );

    for (const res of responses.filter((r) => r.status === 429)) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(10);
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual(["code", "error"]);
      expect(json.code).toBe("RATE_LIMITED");
    }

    // Odrzucone requesty niczego nie zapisały.
    expect(await reservationsCollection().countDocuments({ eventId })).toBe(
      passed,
    );

    // Drugi klient z innej sieci nie odczuwa limitu pierwszego.
    const other = await reserveFrom(otherClient, body("H1", "Anna"));
    expect(other.status).toBe(201);
  });
});
