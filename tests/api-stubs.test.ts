import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { GET as getEvents } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as purchase } from "@/app/api/reservations/[id]/purchase/route";

// Handlery wołamy bezpośrednio, poza requestem Next.js.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/events", () => {
  it("zwraca listę spektakli", async () => {
    const res = await getEvents();
    expect(res.status).toBe(200);
    const events = await res.json();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toEqual({
      _id: expect.any(String),
      title: expect.any(String),
      date: expect.any(String),
      time: expect.any(String),
      stage: expect.any(String),
    });
  });
});

describe("GET /api/events/:id", () => {
  it("zwraca { event, takenSeats }", async () => {
    const res = await getEvent(new Request("http://test"), ctx("dziady"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event._id).toBe("dziady");
    expect(Array.isArray(body.takenSeats)).toBe(true);
  });

  it("404 dla nieistniejącego spektaklu", async () => {
    const res = await getEvent(new Request("http://test"), ctx("nie-ma"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "NOT_FOUND",
    });
  });
});

describe("POST /api/reservations/:id/purchase", () => {
  it("201 z kodem biletu", async () => {
    const reservationId = new ObjectId().toHexString();
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
