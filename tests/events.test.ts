import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getEvents } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { eventsCollection, getClient, reservationsCollection } from "@/lib/db";
import type { Event, Reservation } from "@/lib/schemas";

// Handlery wołamy bezpośrednio, poza requestem Next.js.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// Własne id, żeby nie kolidować z danymi innych plików testowych.
const EVENT: Event = {
  _id: "test-events-dziady",
  title: "Dziady",
  date: "2026-11-14",
  time: "19:00",
  stage: "Duża Scena",
};
const OTHER_EVENT: Event = {
  _id: "test-events-wesele",
  title: "Wesele",
  date: "2026-11-21",
  time: "19:00",
  stage: "Duża Scena",
};
const EVENT_IDS = [EVENT._id, OTHER_EVENT._id];

function reservation(
  eventId: string,
  seatId: string,
  status: Reservation["status"],
  expiresInMs: number,
): Reservation {
  const now = Date.now();
  return {
    _id: new ObjectId(),
    eventId,
    seatId,
    customerName: "Jan",
    email: "jan@example.com",
    status,
    expiresAt: new Date(now + expiresInMs),
    createdAt: new Date(now),
    ...(status === "purchased" ? { code: `TEA-${seatId}TEST` } : {}),
  };
}

async function cleanup() {
  await eventsCollection().deleteMany({ _id: { $in: EVENT_IDS } });
  await reservationsCollection().deleteMany({ eventId: { $in: EVENT_IDS } });
}

beforeAll(async () => {
  await cleanup();
  await eventsCollection().insertMany([EVENT, OTHER_EVENT]);
  await reservationsCollection().insertMany([
    reservation(EVENT._id, "A1", "held", 10 * 60_000), // ważna
    reservation(EVENT._id, "A2", "held", -60_000), // wygasła
    reservation(EVENT._id, "C5", "purchased", -60_000), // kupiona (expiresAt bez znaczenia)
    reservation(OTHER_EVENT._id, "F7", "held", 10 * 60_000), // inny spektakl
  ]);
});

afterAll(async () => {
  await cleanup();
  await getClient().close();
});

describe("GET /api/events", () => {
  it("zwraca spektakle z bazy w kształcie z kontraktu", async () => {
    const res = await getEvents();
    expect(res.status).toBe(200);
    const events: Event[] = await res.json();
    const found = events.find((e) => e._id === EVENT._id);
    expect(found).toEqual(EVENT);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        ["_id", "date", "stage", "time", "title"].sort(),
      );
    }
  });
});

describe("GET /api/events/:id", () => {
  it("zwraca { event, takenSeats } z kupionymi i ważnymi rezerwacjami", async () => {
    const res = await getEvent(new Request("http://test"), ctx(EVENT._id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["event", "takenSeats"]);
    expect(body.event).toEqual(EVENT);
    expect([...body.takenSeats].sort()).toEqual(["A1", "C5"]);
  });

  it("wygasła rezerwacja nie blokuje miejsca", async () => {
    const res = await getEvent(new Request("http://test"), ctx(EVENT._id));
    expect((await res.json()).takenSeats).not.toContain("A2");
  });

  it("nie miesza miejsc z innych spektakli", async () => {
    const res = await getEvent(
      new Request("http://test"),
      ctx(OTHER_EVENT._id),
    );
    expect((await res.json()).takenSeats).toEqual(["F7"]);
  });

  it.each([
    ["nieistniejący spektakl", "nie-ma"],
    ["puste id", ""],
    ["id w formacie ObjectId", "507f1f77bcf86cd799439011"],
    ["dziwne znaki", "$where"],
  ])("404 NOT_FOUND: %s", async (_name, id) => {
    const res = await getEvent(new Request("http://test"), ctx(id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "NOT_FOUND",
    });
  });
});
