import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/reservations/[id]/route";
import { paidReservation } from "./fixtures/paid-reservation";

const { findOne } = vi.hoisted(() => ({ findOne: vi.fn() }));
vi.mock("@/lib/db", () => ({ reservationsCollection: () => ({ findOne }) }));
const read = (id = paidReservation._id.toHexString()) =>
  GET(new Request("http://test"), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(paidReservation);
});

describe("GET rezerwacji i rozliczenie", () => {
  it("zwraca paid i wszystkie zapisane wartości bez danych osobowych", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "paid",
      amount: 6000,
      cardAmount: 5000,
      pointsUsed: 1000,
      pointsEarned: 500,
      code: "TEA-TEST01",
      expiresAt: paidReservation.expiresAt.toISOString(),
    });
  });
  it.each(["held", "expired"])(
    "nie ujawnia nagrody/kodu przy stanie %s",
    async (status) => {
      findOne.mockResolvedValue({
        ...paidReservation,
        status: "held",
        expiresAt: new Date(status === "held" ? "2099-01-01" : "2000-01-01"),
      });
      const data = await (await read()).json();
      expect(data.status).toBe(status);
      expect(data.pointsUsed).toBe(1000);
      expect(data).not.toHaveProperty("pointsEarned");
      expect(data).not.toHaveProperty("code");
      expect(data).not.toHaveProperty("cardAmount");
    },
  );
  it("nie wymyśla rozliczenia starszych rezerwacji", async () => {
    findOne.mockResolvedValue({
      ...paidReservation,
      amount: undefined,
      cardAmount: undefined,
      pointsUsed: undefined,
      pointsEarned: undefined,
    });
    expect(await (await read()).json()).toEqual({
      status: "paid",
      amount: null,
      pointsUsed: 0,
      code: "TEA-TEST01",
      expiresAt: paidReservation.expiresAt.toISOString(),
    });
  });
  it("zachowuje nagrodę zero", async () => {
    findOne.mockResolvedValue({ ...paidReservation, pointsEarned: 0 });
    expect((await (await read()).json()).pointsEarned).toBe(0);
  });
  it("404 dla błędnego lub brakującego id", async () => {
    expect((await read("bad-id")).status).toBe(404);
    expect(findOne).not.toHaveBeenCalled();
    findOne.mockResolvedValue(null);
    expect((await read()).status).toBe(404);
  });
  it("503 dla awarii bazy, bez szczegółów błędu", async () => {
    findOne.mockRejectedValue(new Error("private database details"));
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});
