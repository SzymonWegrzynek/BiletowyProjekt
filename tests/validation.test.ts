import { describe, expect, it } from "vitest";
import { POST as createReservation } from "@/app/api/reservations/route";
import { createReservationSchema, reservationIdSchema } from "@/lib/schemas";

function postJson(body: unknown) {
  return new Request("http://test/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRaw(body: string) {
  return new Request("http://test/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const valid = {
  eventId: "dziady",
  seatId: "B3",
  customerName: "Jan",
  email: "jan@example.com",
};

// Wszystko tu odpada na walidacji, przed bazą — działa także bez MONGODB_URI.
describe("POST /api/reservations — 400 z komunikatem dla klienta", () => {
  it.each([
    ["brak imienia", { ...valid, customerName: undefined }, "Podaj imię"],
    ["imię nie tekstem", { ...valid, customerName: 123 }, "Podaj imię"],
    ["puste imię", { ...valid, customerName: "   " }, "Podaj imię"],
    [
      "imię za długie",
      { ...valid, customerName: "a".repeat(101) },
      "Imię może mieć najwyżej 100 znaków",
    ],
    ["brak e-maila", { ...valid, email: undefined }, "Podaj adres e-mail"],
    ["pusty e-mail", { ...valid, email: "  " }, "Podaj adres e-mail"],
    ["zły e-mail", { ...valid, email: "niemail" }, "Niepoprawny adres e-mail"],
    [
      "e-mail za długi",
      { ...valid, email: `${"a".repeat(250)}@example.com` },
      "Niepoprawny adres e-mail",
    ],
    ["brak miejsca", { ...valid, seatId: undefined }, "Wybierz miejsce"],
    [
      "miejsce spoza widowni",
      { ...valid, seatId: "Z99" },
      "Miejsce musi mieć format rząd A–H i numer 1–10, np. F7",
    ],
    [
      "małe litery w miejscu",
      { ...valid, seatId: "f7" },
      "Miejsce musi mieć format rząd A–H i numer 1–10, np. F7",
    ],
    ["brak spektaklu", { ...valid, eventId: undefined }, "Wybierz spektakl"],
    [
      "operator Mongo zamiast id",
      { ...valid, eventId: { $ne: null } },
      "Wybierz spektakl",
    ],
    [
      "id spektaklu za długie",
      { ...valid, eventId: "e".repeat(101) },
      "Nie ma takiego spektaklu",
    ],
    [
      "tablica zamiast obiektu",
      [valid],
      "Wyślij dane rezerwacji: spektakl, miejsce, imię i e-mail",
    ],
    ["null", null, "Wyślij dane rezerwacji: spektakl, miejsce, imię i e-mail"],
  ])("%s", async (_name, body, message) => {
    const res = await createReservation(postJson(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: message,
      code: "VALIDATION_ERROR",
    });
  });

  it.each([
    ["niepoprawny JSON", "{ eventId: "],
    ["puste body", ""],
  ])("%s → 400, nie 500", async (_name, raw) => {
    const res = await createReservation(postRaw(raw));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
  });
});

describe("createReservationSchema — co trafia do bazy", () => {
  it("usuwa pola spoza kontraktu (np. status, code)", () => {
    const parsed = createReservationSchema.parse({
      ...valid,
      status: "purchased",
      code: "TEA-HACK00",
      _id: "x",
    });
    expect(parsed).toEqual(valid);
  });

  it("przycina spacje w imieniu i e-mailu", () => {
    const parsed = createReservationSchema.parse({
      ...valid,
      customerName: "  Jan  ",
      email: " jan@example.com ",
    });
    expect(parsed.customerName).toBe("Jan");
    expect(parsed.email).toBe("jan@example.com");
  });

  it("przyjmuje wartości na granicy limitów", () => {
    const result = createReservationSchema.safeParse({
      ...valid,
      customerName: "a".repeat(100),
      seatId: "H10",
    });
    expect(result.success).toBe(true);
  });
});

describe("reservationIdSchema", () => {
  it.each([
    ["507f1f77bcf86cd799439011", true],
    ["507F1F77BCF86CD799439011", true],
    ["xyz", false],
    ["aaaaaaaaaaaa", false],
    ["507f1f77bcf86cd79943901", false],
    ["507f1f77bcf86cd7994390111", false],
    ["507f1f77bcf86cd79943901g", false],
    ["", false],
  ])("%s → %s", (id, ok) => {
    expect(reservationIdSchema.safeParse(id).success).toBe(ok);
  });
});
