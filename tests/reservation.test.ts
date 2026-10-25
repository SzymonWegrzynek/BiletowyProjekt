import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getClient, reservationsCollection } from "@/lib/db";
import {
  activeReservationFilter,
  getTtlMinutes,
  reservationExpiresAt,
} from "@/lib/reservation";
import type { Reservation } from "@/lib/schemas";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTtlMinutes", () => {
  it("domyślnie 15 minut", () => {
    vi.stubEnv("RESERVATION_TTL_MINUTES", undefined);
    expect(getTtlMinutes()).toBe(15);
  });

  it("czyta RESERVATION_TTL_MINUTES", () => {
    vi.stubEnv("RESERVATION_TTL_MINUTES", "2");
    expect(getTtlMinutes()).toBe(2);
  });

  it.each(["abc", "0", "-5"])("odrzuca niepoprawną wartość %s", (value) => {
    vi.stubEnv("RESERVATION_TTL_MINUTES", value);
    expect(() => getTtlMinutes()).toThrow("RESERVATION_TTL_MINUTES");
  });
});

describe("reservationExpiresAt", () => {
  it("dodaje TTL do podanego czasu serwera", () => {
    vi.stubEnv("RESERVATION_TTL_MINUTES", "15");
    const now = new Date("2026-11-14T18:00:00.000Z");
    expect(reservationExpiresAt(now).toISOString()).toBe(
      "2026-11-14T18:15:00.000Z",
    );
  });
});

describe("activeReservationFilter", () => {
  it("kupione zawsze, held tylko z expiresAt > now", () => {
    const now = new Date("2026-11-14T18:00:00.000Z");
    expect(activeReservationFilter(now)).toEqual({
      $or: [
        { status: "purchased" },
        { status: "held", expiresAt: { $gt: now } },
      ],
    });
  });
});

// Sprawdza, jak filtr zachowuje się w prawdziwym MongoDB (baza teatr-test).
// Bez MONGODB_URI (np. w CI bez sekretu) te testy są pomijane.
describe.skipIf(!process.env.MONGODB_URI)(
  "activeReservationFilter w MongoDB",
  () => {
    // Unikalny eventId: równoległe testy i inne osoby na teatr-test sobie nie przeszkadzają.
    const eventId = `test-wygasanie-${randomUUID()}`;
    const now = new Date();
    const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

    function reservation(
      seatId: string,
      status: Reservation["status"],
      expiresAt: Date,
    ): Reservation {
      return {
        _id: new ObjectId(),
        eventId,
        seatId,
        customerName: "Test",
        email: "test@example.com",
        status,
        expiresAt,
        createdAt: now,
        ...(status === "purchased" && { code: `TEA-${seatId}` }),
      };
    }

    afterAll(async () => {
      await reservationsCollection().deleteMany({ eventId });
      await getClient().close();
    });

    it("wygasła rezerwacja nie blokuje miejsca", async () => {
      await reservationsCollection().insertMany([
        reservation("A1", "purchased", minutes(-60)), // kupiony dawno: zajęte
        reservation("A2", "held", minutes(5)), // ważna rezerwacja: zajęte
        reservation("A3", "held", minutes(-1)), // wygasła: wolne
        reservation("A4", "held", now), // wygasa dokładnie teraz: wolne
      ]);

      const taken = await reservationsCollection()
        .find({ eventId, ...activeReservationFilter(now) })
        .map((r) => r.seatId)
        .toArray();

      expect(taken.sort()).toEqual(["A1", "A2"]);
    }, 20_000); // pierwsze połączenie z Atlasem trwa kilka sekund
  },
);
