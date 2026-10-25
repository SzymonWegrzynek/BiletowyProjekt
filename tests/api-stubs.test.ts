import { describe, expect, it, vi } from "vitest";
import { POST as createReservation } from "@/app/api/reservations/route";
import { POST as purchase } from "@/app/api/reservations/[id]/purchase/route";

// Handlery wołamy bezpośrednio, poza requestem Next.js.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postJson(body: unknown) {
  return new Request("http://test/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validReservation = {
  eventId: "dziady",
  seatId: "B3",
  customerName: "Jan",
  email: "jan@example.com",
};

describe("POST /api/reservations", () => {
  it("201 z reservationId i expiresAt w przyszłości", async () => {
    const res = await createReservation(postJson(validReservation));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.reservationId).toBe("string");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it.each([
    ["zły e-mail", { ...validReservation, email: "niemail" }],
    ["puste imię", { ...validReservation, customerName: "  " }],
    ["miejsce spoza widowni", { ...validReservation, seatId: "Z99" }],
    ["brak body", null],
  ])("400 VALIDATION_ERROR: %s", async (_name, body) => {
    const res = await createReservation(postJson(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_ERROR");
    expect(json.error).not.toMatch(/Invalid|expected/);
  });

  it("404 dla nieistniejącego spektaklu", async () => {
    const res = await createReservation(
      postJson({ ...validReservation, eventId: "nie-ma" }),
    );
    expect(res.status).toBe(404);
  });

  it("409 SEAT_TAKEN dla zajętego miejsca", async () => {
    const res = await createReservation(
      postJson({ ...validReservation, seatId: "F7" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SEAT_TAKEN");
  });
});

describe("POST /api/reservations/:id/purchase", () => {
  it("201 z kodem biletu", async () => {
    const reserved = await createReservation(postJson(validReservation));
    const { reservationId } = await reserved.json();
    const res = await purchase(new Request("http://test"), ctx(reservationId));
    expect(res.status).toBe(201);
    expect((await res.json()).code).toMatch(/^TEA-[0-9A-Z]{6}$/);
  });

  it("404 dla niepoprawnego id", async () => {
    const res = await purchase(new Request("http://test"), ctx("xyz"));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});
