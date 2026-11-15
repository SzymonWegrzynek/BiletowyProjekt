import { describe, expect, it } from "vitest";
import { createSeedReservations, SEED_EVENTS } from "@/lib/seed-data";
import { STUB_EVENTS } from "@/lib/stubs";
import { eventSchema } from "@/lib/schemas";

describe("ceny danych przykładowych", () => {
  it("seed i zaślepki mają te same ceny w groszach", () => {
    expect(STUB_EVENTS).toEqual(SEED_EVENTS);
    expect(SEED_EVENTS.map(({ _id, price }) => [_id, price])).toEqual([
      ["dziady", 6000],
      ["wesele", 6000],
      ["kordian", 4500],
    ]);
    for (const event of SEED_EVENTS)
      expect(eventSchema.safeParse(event).success).toBe(true);
  });
  it("każdy przykładowy bilet otrzymuje kwotę swojego spektaklu", () => {
    const first = createSeedReservations(new Date());
    const second = createSeedReservations(new Date());
    expect(first).toHaveLength(5);
    for (const reservation of first) {
      expect(reservation.amount).toBe(
        SEED_EVENTS.find((event) => event._id === reservation.eventId)?.price,
      );
      expect(reservation.status).toBe("purchased");
    }
    expect(
      second.map(({ eventId, seatId, amount, code }) => ({
        eventId,
        seatId,
        amount,
        code,
      })),
    ).toEqual(
      first.map(({ eventId, seatId, amount, code }) => ({
        eventId,
        seatId,
        amount,
        code,
      })),
    );
  });
  it.each([-1, 60.5, NaN])("odrzuca niepoprawną cenę %s", (price) => {
    expect(eventSchema.safeParse({ ...SEED_EVENTS[0], price }).success).toBe(
      false,
    );
  });
});
