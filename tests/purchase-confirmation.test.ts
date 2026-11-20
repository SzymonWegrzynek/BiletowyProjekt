import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/reservations/[id]/purchase/route";
import { paidReservation } from "./fixtures/paid-reservation";

const { purchase, find, send } = vi.hoisted(() => ({
  purchase: vi.fn(),
  find: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  reservationsCollection: () => ({ findOneAndUpdate: purchase, findOne: find }),
}));
vi.mock("@/lib/server/send-ticket-confirmation", () => ({
  sendTicketConfirmation: send,
}));
beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue("accepted");
});
const buy = () =>
  POST(
    new Request("http://test", {
      method: "POST",
      body: JSON.stringify({
        email: "attacker@example.com",
        pointsEarned: 999999,
      }),
    }),
    { params: Promise.resolve({ id: paidReservation._id.toHexString() }) },
  );

it("uruchamia mail dopiero po zapisie zakupu, przekazując wyłącznie id", async () => {
  purchase.mockImplementation(async () => {
    expect(send).not.toHaveBeenCalled();
    return paidReservation;
  });
  const response = await buy();
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ code: paidReservation.code });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    paidReservation._id.toHexString(),
  );
});
it("nie wysyła dla odrzuconego, wygasłego zakupu", async () => {
  purchase.mockResolvedValue(null);
  find.mockResolvedValue({ status: "held" });
  expect((await buy()).status).toBe(410);
  expect(send).not.toHaveBeenCalled();
});
it("nie wysyła dla brakującej rezerwacji", async () => {
  purchase.mockResolvedValue(null);
  find.mockResolvedValue(null);
  expect((await buy()).status).toBe(404);
  expect(send).not.toHaveBeenCalled();
});
it("awaria usługi mailowej nie zmienia sukcesu zakupu", async () => {
  purchase.mockResolvedValue(paidReservation);
  send.mockResolvedValue("failed");
  expect((await buy()).status).toBe(201);
});
