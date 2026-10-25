import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as purchase } from "@/app/api/reservations/[id]/purchase/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  reservationsCollection,
} from "@/lib/db";
import type { Reservation } from "@/lib/schemas";
import { generateTicketCode } from "@/lib/ticket";

const CODE_FORMAT = /^TEA-[A-HJ-NP-Z2-9]{6}$/;

function buy(id: string) {
  return purchase(new Request("http://test", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

describe("generateTicketCode", () => {
  it("format TEA-XXXXXX bez mylących znaków, kody się nie powtarzają", () => {
    const codes = Array.from({ length: 1000 }, generateTicketCode);
    for (const code of codes) expect(code).toMatch(CODE_FORMAT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("POST /api/reservations/:id/purchase — bez bazy", () => {
  it.each(["xyz", "123", "nie-objectid-24-znakowy!"])(
    "404 dla niepoprawnego id %s (a nie 500)",
    async (id) => {
      const res = await buy(id);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("NOT_FOUND");
    },
  );
});

describe.skipIf(!process.env.MONGODB_URI)(
  "POST /api/reservations/:id/purchase",
  () => {
    const eventId = `test-zakup-${randomUUID()}`;
    const reservations = () => reservationsCollection();
    let seat = 0;

    // Każdy test na osobnym miejscu, żeby unikalny indeks ich nie mieszał.
    async function insertHeld(expiresInMs: number): Promise<string> {
      seat += 1;
      const now = Date.now();
      const doc: Reservation = {
        _id: new ObjectId(),
        eventId,
        seatId: `B${seat}`,
        customerName: "Jan",
        email: "jan@example.com",
        status: "held",
        expiresAt: new Date(now + expiresInMs),
        createdAt: new Date(now),
      };
      await reservations().insertOne(doc);
      return doc._id.toHexString();
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

    it("ścieżka główna: rezerwacja → zakup → 201 { code }, bilet w bazie", async () => {
      const reserved = await createReservation(
        new Request("http://test/api/reservations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventId,
            seatId: "A1",
            customerName: "Jan",
            email: "jan@example.com",
          }),
        }),
      );
      expect(reserved.status).toBe(201);
      const { reservationId } = await reserved.json();

      const res = await buy(reservationId);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(Object.keys(json)).toEqual(["code"]);
      expect(json.code).toMatch(CODE_FORMAT);

      const saved = await reservations().findOne({
        _id: new ObjectId(reservationId),
      });
      expect(saved).toMatchObject({
        status: "purchased",
        code: json.code,
        seatId: "A1",
      });
    });

    it("podwójny zakup: 200 z tym samym kodem, jeden bilet", async () => {
      const id = await insertHeld(5 * 60_000);
      const first = await (await buy(id)).json();

      const again = await buy(id);
      expect(again.status).toBe(200);
      expect((await again.json()).code).toBe(first.code);
      expect(await reservations().countDocuments({ code: first.code })).toBe(1);
    });

    it("20 równoczesnych zakupów: 1 × 201, 19 × 200, wszędzie ten sam kod", async () => {
      const id = await insertHeld(5 * 60_000);
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => buy(id)),
      );
      const statuses = responses.map((r) => r.status);
      const codes = await Promise.all(
        responses.map(async (r) => (await r.json()).code),
      );

      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(19);
      expect(new Set(codes).size).toBe(1);

      const saved = await reservations().findOne({ _id: new ObjectId(id) });
      expect(saved?.code).toBe(codes[0]);
    });

    it("410 RESERVATION_EXPIRED po czasie, bilet nie powstaje", async () => {
      const id = await insertHeld(-60_000);
      const res = await buy(id);
      expect(res.status).toBe(410);
      expect((await res.json()).code).toBe("RESERVATION_EXPIRED");

      const saved = await reservations().findOne({ _id: new ObjectId(id) });
      expect(saved?.status).toBe("held");
      expect(saved?.code).toBeUndefined();
    });

    it("404 NOT_FOUND: poprawne id, ale nie ma takiej rezerwacji", async () => {
      const res = await buy(new ObjectId().toHexString());
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("NOT_FOUND");
    });
  },
);
