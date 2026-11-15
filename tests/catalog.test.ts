import { describe, expect, it } from "vitest";
import { catalogEventSchema, eventSchema } from "@/lib/schemas";

const legacyEvent = {
  _id: "dziady",
  title: "Dziady",
  date: "2026-11-14",
  time: "19:00",
  stage: "Duża Scena",
};

describe("repertuar podczas migracji cen", () => {
  it("wczytuje spektakle bez price, bez wymyślania ceny", () => {
    const result = catalogEventSchema.array().parse([legacyEvent]);
    expect(result).toEqual([legacyEvent]);
    expect(result[0].price).toBeUndefined();
  });
  it("wczytuje listę zawierającą stare i nowe rekordy", () => {
    const events = [
      legacyEvent,
      { ...legacyEvent, _id: "wesele", price: 6000 },
    ];
    expect(catalogEventSchema.array().parse(events)).toEqual(events);
  });
  it("dalej wymaga ceny w nowych danych", () => {
    expect(eventSchema.safeParse(legacyEvent).success).toBe(false);
  });
  it.each([-1, 60.5, "6000"])("nie akceptuje błędnej ceny %s", (price) => {
    expect(
      catalogEventSchema.safeParse({ ...legacyEvent, price }).success,
    ).toBe(false);
  });
});
