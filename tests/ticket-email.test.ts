import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTicketEmail } from "@/lib/server/ticket-email";
import { sendWithResend } from "@/lib/server/resend";
import { sendTicketConfirmation } from "@/lib/server/send-ticket-confirmation";
import { reservationSummary } from "@/lib/reservation-summary";
import { formatPrice } from "@/lib/format";
import { paidEvent, paidReservation } from "./fixtures/paid-reservation";
import type { Reservation } from "@/lib/schemas";

const { findReservation, findEvent, update } = vi.hoisted(() => ({
  findReservation: vi.fn(),
  findEvent: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  reservationsCollection: () => ({
    findOne: findReservation,
    updateOne: update,
  }),
  eventsCollection: () => ({ findOne: findEvent }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("RESEND_FROM", "Teatr <onboarding@resend.dev>");
  vi.stubEnv("RESEND_MODE", "test");
  findReservation.mockResolvedValue({ ...paidReservation });
  findEvent.mockResolvedValue(paidEvent);
  update.mockResolvedValue({ modifiedCount: 1 });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ id: "mail-id" })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("treść maila z utrwalonej rezerwacji", () => {
  it("ma ten sam kod i trzy wartości co odczyt API", () => {
    const api = reservationSummary(paidReservation);
    const email = buildTicketEmail(paidReservation, {
      ...paidEvent,
      price: 99999,
    })!;
    expect(email.to).toEqual(["delivered@resend.dev"]);
    expect(email.text).toContain(
      `Zapłacono kartą: ${formatPrice(api.cardAmount!)}`,
    );
    expect(email.text).toContain(
      `Użyte punkty: ${api.pointsUsed.toLocaleString("pl-PL")}`,
    );
    expect(email.text).toContain(`Zdobyte punkty: ${api.pointsEarned}`);
    for (const part of [
      paidEvent.title,
      paidEvent.date,
      paidEvent.time,
      paidEvent.stage,
      "Rząd F, miejsce 7",
      api.code!,
    ])
      expect(email.text).toContain(part);
  });
  it("nie przelicza nagrody i obsługuje zakup bez punktów", () => {
    const email = buildTicketEmail(
      {
        ...paidReservation,
        cardAmount: 6000,
        pointsUsed: 0,
        pointsEarned: 137,
      },
      paidEvent,
    )!;
    expect(email.text).toContain("Zapłacono kartą: 60 zł");
    expect(email.text).toContain("Użyte punkty: 0");
    expect(email.text).toContain("Zdobyte punkty: 137");
  });
  it.each([
    { status: "held" },
    { status: "rejected" },
    { status: "expired" },
    { code: undefined },
    { pointsEarned: undefined },
    { cardAmount: undefined },
    { pointsUsed: -1 },
    { cardAmount: 5001 },
    { pointsEarned: 1.5 },
  ])(
    "nie buduje potwierdzenia bez zakupu/kompletu rozliczenia %j",
    (changes) => {
      expect(
        buildTicketEmail(
          { ...paidReservation, ...changes } as Reservation,
          paidEvent,
        ),
      ).toBeNull();
    },
  );
  it("escapuje tekst w HTML", () => {
    const email = buildTicketEmail(paidReservation, {
      ...paidEvent,
      title: '<img src=x onerror="alert(1)">',
    })!;
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img");
  });
});

describe("wysyłka po potwierdzeniu zakupu", () => {
  const id = paidReservation._id.toHexString();
  it("odczytuje rezerwację po id i wysyła do Resend z kluczem idempotencji", async () => {
    expect(await sendTicketConfirmation(id)).toBe("accepted");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Idempotency-Key": expect.stringMatching(/^ticket-confirmation\//),
    });
    const body = JSON.parse(options!.body as string);
    expect(body.to).toEqual(["delivered@resend.dev"]);
    expect(body.text).toContain("Zapłacono kartą: 50 zł");
    expect(update).toHaveBeenLastCalledWith(expect.anything(), {
      $set: {
        "confirmationEmail.status": "accepted",
        "confirmationEmail.providerId": "mail-id",
        "confirmationEmail.acceptedAt": expect.any(Date),
        "confirmationEmail.deliveryStatus": "unknown",
      },
    });
  });
  it("przy dwóch równoczesnych wywołaniach wysyła tylko zwycięzca atomowego claim", async () => {
    update
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    const results = await Promise.all([
      sendTicketConfirmation(id),
      sendTicketConfirmation(id),
    ]);
    expect(results.sort()).toEqual(["accepted", "already-claimed"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["sending", "sent", "failed"])(
    "nie wysyła ponownie stanu %s",
    async (status) => {
      findReservation.mockResolvedValue({
        ...paidReservation,
        confirmationEmail: { status },
      });
      expect(await sendTicketConfirmation(id)).toBe("already-claimed");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: "held" },
    { status: "rejected" },
    { pointsEarned: undefined },
    { email: "customer@example.com" },
  ])("nie wysyła dla %j", async (changes) => {
    findReservation.mockResolvedValue({ ...paidReservation, ...changes });
    expect(await sendTicketConfirmation(id)).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("brak klucza nie blokuje zakupu", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendTicketConfirmation(id)).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("awaria Resend jest utrwalona i nie zgłasza błędu płatności", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ message: "private" }, { status: 503 }),
    );
    expect(await sendTicketConfirmation(id)).toBe("retryable");
    expect(update).toHaveBeenLastCalledWith(expect.anything(), {
      $set: expect.objectContaining({
        "confirmationEmail.status": "retryable",
        "confirmationEmail.lastError": "http_503",
      }),
    });
  });
  it("transport odrzuca niepotwierdzoną odpowiedź usługodawcy", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({}));
    await expect(
      sendWithResend(buildTicketEmail(paidReservation, paidEvent)!, "test-key"),
    ).rejects.toThrow("nie potwierdził");
  });
  it("transport zawsze ma timeout", async () => {
    await sendWithResend(
      buildTicketEmail(paidReservation, paidEvent)!,
      "test-key",
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });
});
