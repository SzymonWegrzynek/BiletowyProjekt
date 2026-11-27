import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import TicketPage from "@/app/bilet/[code]/page";
import { PointsEarned } from "@/components/PointsEarned";
import { formatEventDate } from "@/lib/format";
import { buildTicketEmail } from "@/lib/server/ticket-email";
import { paidEvent, paidReservation } from "./fixtures/paid-reservation";
import type { EmailOperation } from "@/lib/email-state";

const { reservation, event } = vi.hoisted(() => ({
  reservation: vi.fn(),
  event: vi.fn(),
}));

it.each([
  { status: "retryable", deliveryStatus: "unknown" },
  { status: "blocked", deliveryStatus: "unknown" },
  { status: "accepted", deliveryStatus: "unknown" },
  { status: "accepted", deliveryStatus: "bounced" },
  { status: "accepted", deliveryStatus: "delivered" },
] as const)(
  "bilet i rozliczenie pozostają dostępne przy stanie poczty $status/$deliveryStatus",
  async (mailState) => {
    const confirmationEmail: EmailOperation = {
      ...mailState,
      attemptedAt: new Date(),
      requestBody: "PRIVATE_MAIL_BODY",
    };
    reservation.mockResolvedValue({ ...paidReservation, confirmationEmail });
    event.mockResolvedValue(paidEvent);
    const html = renderToStaticMarkup(
      await TicketPage({
        params: Promise.resolve({ code: paidReservation.code! }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain(paidReservation.code!);
    expect(html).toContain("Bilet kupiony");
    expect(html).toContain("50 zł");
    expect(html).toContain("Zdobyte punkty");
    expect(html).not.toContain("PRIVATE_MAIL_BODY");
    if (
      mailState.deliveryStatus === "unknown" &&
      mailState.status === "accepted"
    ) {
      expect(html).toContain("Nie mamy jeszcze potwierdzenia doręczenia");
      expect(html).not.toContain("potwierdził doręczenie");
    }
    if (mailState.deliveryStatus === "bounced")
      expect(html).toContain("odrzucona");
  },
);
vi.mock("@/lib/db", () => ({
  reservationsCollection: () => ({ findOne: reservation }),
  eventsCollection: () => ({ findOne: event }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  event.mockResolvedValue({
    title: "Dziady",
    date: "2026-12-01",
    time: "19:00",
    stage: "Duża Scena",
  });
});

it("bilet odczytuje nagrodę z rezerwacji, bez wyliczania z kwoty", async () => {
  reservation.mockResolvedValue({
    status: "purchased",
    code: "TEA-TEST",
    eventId: "dziady",
    seatId: "A1",
    amount: 6000,
    cardAmount: 5000,
    pointsUsed: 1000,
    pointsEarned: 137,
  });
  const page = await TicketPage({
    params: Promise.resolve({ code: "TEA-TEST" }),
    searchParams: Promise.resolve({}),
  });
  const html = renderToStaticMarkup(page);
  expect(html).toContain("Zdobyte punkty");
  expect(html).toContain("137");
  expect(reservation).toHaveBeenCalledWith(
    { code: "TEA-TEST" },
    expect.objectContaining({
      projection: expect.objectContaining({
        pointsEarned: 1,
        pointsUsed: 1,
        cardAmount: 1,
        amount: 1,
      }),
    }),
  );
});

it.each([
  {
    amount: 6000,
    cardAmount: 5000,
    pointsUsed: 1000,
    pointsEarned: 500,
    card: "50 zł",
    used: "1000",
    earned: "500",
  },
  {
    amount: 6000,
    cardAmount: 6000,
    pointsUsed: 0,
    pointsEarned: 600,
    card: "60 zł",
    used: "0",
    earned: "600",
  },
  {
    amount: 5550,
    cardAmount: 4550,
    pointsUsed: 1000,
    pointsEarned: 450,
    card: "45,50 zł",
    used: "1000",
    earned: "450",
  },
  {
    amount: 0,
    cardAmount: 0,
    pointsUsed: 0,
    pointsEarned: 0,
    card: "0 zł",
    used: "0",
    earned: "0",
  },
])(
  "strona i mail mają identyczne rozliczenie $card / $used / $earned",
  async ({ card, used, earned, ...amounts }) => {
    const stored = { ...paidReservation, ...amounts };
    reservation.mockResolvedValue(stored);
    // Bieżąca cena spektaklu nie może zmienić historycznej płatności.
    event.mockResolvedValue({ ...paidEvent, price: 99999 });
    const html = renderToStaticMarkup(
      await TicketPage({
        params: Promise.resolve({ code: stored.code! }),
        searchParams: Promise.resolve({}),
      }),
    );
    const email = buildTicketEmail(stored, { ...paidEvent, price: 99999 })!;
    const rows = [
      ...html.matchAll(/<dt[^>]*>(.*?)<\/dt>\s*<dd[^>]*>(.*?)<\/dd>/g),
    ];
    const rendered = Object.fromEntries(
      rows.map(([, label, value]) => [label, value]),
    );
    for (const [label, value] of [
      ["Zapłacono kartą", card],
      ["Użyte punkty", used],
      ["Zdobyte punkty", earned],
    ]) {
      expect(rendered[label]).toBe(value);
      expect(email.text).toContain(`${label}: ${value}`);
      expect(email.html).toContain(`>${value}</td>`);
    }
    expect(html).toContain(stored.code!);
    expect(html).toContain(paidEvent.title);
    // Strona pokazuje datę po polsku (nowy wygląd), mail — tak jak dotąd.
    const date = formatEventDate(paidEvent.date)!;
    expect(html).toContain(`${date.day} ${date.month} ${date.year}`);
    expect(html).toContain(paidEvent.time);
    expect(html).toContain(paidEvent.stage);
    expect(html).toContain("Rząd F, miejsce 7");
  },
);

it.each([
  { cardAmount: undefined },
  { pointsUsed: undefined },
  { pointsEarned: undefined },
  { cardAmount: 5001 },
  { pointsUsed: -1 },
  { pointsEarned: 1.5 },
])(
  "przy niepełnym lub niespójnym rozliczeniu zachowuje bilet bez fikcyjnych wartości %j",
  async (changes) => {
    const stored = { ...paidReservation, ...changes };
    reservation.mockResolvedValue(stored);
    event.mockResolvedValue(paidEvent);
    const html = renderToStaticMarkup(
      await TicketPage({
        params: Promise.resolve({ code: stored.code! }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain("Pełne rozliczenie zakupu jest jeszcze niedostępne");
    expect(html).toContain(stored.code!);
    expect(html).not.toContain("Zdobyte punkty</dt>");
    expect(buildTicketEmail(stored, paidEvent)).toBeNull();
  },
);

it.each(["held", "expired", "rejected"])(
  "nie renderuje biletu/rozliczenia dla stanu %s mimo obecności kodu i punktów",
  async (status) => {
    reservation.mockResolvedValue({ ...paidReservation, status });
    await expect(
      TicketPage({
        params: Promise.resolve({ code: paidReservation.code! }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NOT_FOUND");
  },
);

it("nie pokazuje nagrody dla nieopłaconej rezerwacji", async () => {
  reservation.mockResolvedValue({
    status: "held",
    code: "TEA-TEST",
    pointsEarned: 500,
  });
  await expect(
    TicketPage({
      params: Promise.resolve({ code: "TEA-TEST" }),
      searchParams: Promise.resolve({}),
    }),
  ).rejects.toThrow("NOT_FOUND");
});

it("rozróżnia nagrodę 0 i brak rozliczenia", () => {
  expect(
    renderToStaticMarkup(createElement(PointsEarned, { pointsEarned: 0 })),
  ).toContain(">0</dd>");
  for (const pointsEarned of [undefined, -1, 1.5, NaN]) {
    expect(
      renderToStaticMarkup(createElement(PointsEarned, { pointsEarned })),
    ).toContain("Informacja o nagrodzie jest jeszcze niedostępna.");
  }
});
