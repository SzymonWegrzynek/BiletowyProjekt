import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendTicketConfirmation,
  checkTicketDelivery,
} from "@/lib/server/send-ticket-confirmation";
import { allowedRecipient } from "@/lib/server/resend";
import {
  emailRetryDecision,
  emailStatusMessage,
  EMAIL_RETRY_WINDOW_MS,
} from "@/lib/email-state";
import { paidEvent, paidReservation } from "./fixtures/paid-reservation";
import type { Reservation } from "@/lib/schemas";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  update: vi.fn(),
  event: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  reservationsCollection: () => ({
    findOne: mocks.find,
    updateOne: mocks.update,
  }),
  eventsCollection: () => ({ findOne: mocks.event }),
}));
let stored: Reservation;
const id = paidReservation._id.toHexString();
const start = new Date("2026-11-20T12:00:00Z");
const retry = () => sendTicketConfirmation(id, { retry: true });
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

// Model atomowego updateOne: sprawdza filtr na bieżącym dokumencie,
// a każdy odczyt zwraca niezależną kopię stanu operacji.
function valueAt(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown>)?.[key],
      stored,
    );
}
function matches(filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = valueAt(key);
    if (key === "_id") return String(actual) === String(expected);
    if (expected && typeof expected === "object") {
      if ("$exists" in expected)
        return (actual !== undefined) === expected.$exists;
      if ("$nin" in expected)
        return !(expected.$nin as unknown[]).includes(actual);
    }
    return actual === expected;
  });
}
function update(
  filter: Record<string, unknown>,
  change: { $set: Record<string, unknown> },
) {
  if (!matches(filter)) return { modifiedCount: 0 };
  for (const [key, value] of Object.entries(change.$set)) {
    if (key === "confirmationEmail")
      stored.confirmationEmail = structuredClone(
        value,
      ) as Reservation["confirmationEmail"];
    else {
      expect(key.startsWith("confirmationEmail.")).toBe(true);
      const target = stored.confirmationEmail as unknown as Record<
        string,
        unknown
      >;
      target[key.slice("confirmationEmail.".length)] = structuredClone(value);
    }
  }
  return { modifiedCount: 1 };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubEnv("RESEND_API_KEY", "mock-key");
  vi.stubEnv("RESEND_FROM", "Teatr <onboarding@resend.dev>");
  vi.stubEnv("RESEND_MODE", "test");
  stored = { ...paidReservation, email: "delivered+retry@resend.dev" };
  mocks.find.mockImplementation(async () => ({
    ...stored,
    confirmationEmail: structuredClone(stored.confirmationEmail),
  }));
  mocks.event.mockResolvedValue(paidEvent);
  mocks.update.mockImplementation(async (filter, change) =>
    update(filter, change),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json({ id: "mail-1" })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("bezpieczne ponowienia maila", () => {
  it("spóźniona odpowiedź starej próby nie nadpisuje wyniku nowszej", async () => {
    let rejectOld!: (error: Error) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const original = sendTicketConfirmation(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.confirmationEmail?.status).toBe("sending");
    advance(60_001);
    expect(await retry()).toBe("accepted");
    rejectOld(new Error("late timeout"));
    await original;
    expect(stored.confirmationEmail?.status).toBe("accepted");
    expect(stored.confirmationEmail?.providerId).toBe("mail-1");
    expect(stored.confirmationEmail?.attempts).toBe(2);
  });
  it("timeout po przyjęciu: retry zachowuje klucz i payload, usługodawca tworzy jeden mail", async () => {
    const messages = new Map<string, string>();
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const key = (options!.headers as Record<string, string>)[
        "Idempotency-Key"
      ];
      if (!messages.has(key)) {
        messages.set(key, options!.body as string);
        throw new DOMException("timeout", "TimeoutError");
      }
      expect(options!.body).toBe(messages.get(key));
      return Response.json({ id: "mail-1" });
    });
    expect(await sendTicketConfirmation(id)).toBe("retryable");
    expect(stored.confirmationEmail?.lastError).toBe("timeout_or_network");
    expect(await retry()).toBe("wait");
    // Zmiana nadawcy i danych spektaklu nie zmienia utrwalonego requestu.
    vi.stubEnv("RESEND_FROM", "Inny <other@example.com>");
    mocks.event.mockResolvedValue({ ...paidEvent, title: "Zmieniony" });
    advance(30_001);
    expect(await retry()).toBe("accepted");
    expect(messages.size).toBe(1);
    expect(stored.confirmationEmail?.attempts).toBe(2);
    expect(stored.confirmationEmail?.deliveryStatus).toBe("unknown");
    expect(stored.pointsEarned).toBe(500);
    expect(stored.pointsUsed).toBe(1000);
    expect(stored.status).toBe("purchased");
  });
  it("5xx nie wywołuje automatycznej pętli, powtórzony webhook niczego nie wysyła", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await sendTicketConfirmation(id)).toBe("retryable");
    advance(60_000);
    expect(await sendTicketConfirmation(id)).toBe("already-claimed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await retry()).toBe("accepted");
    expect(await sendTicketConfirmation(id)).toBe("already-claimed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("dwa równoczesne retry dostają tylko jeden lease", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await sendTicketConfirmation(id);
    advance(30_001);
    const outcomes = await Promise.all([retry(), retry()]);
    expect(outcomes.sort()).toEqual(["accepted", "already-claimed"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("odzyskuje operację po utracie zapisu id po 2xx bez nowego klucza", async () => {
    mocks.update
      .mockImplementationOnce(async (filter, change) => update(filter, change))
      .mockRejectedValueOnce(new Error("database unavailable"));
    expect(await sendTicketConfirmation(id)).toBe("failed");
    const original = stored.confirmationEmail?.operationId;
    expect(stored.confirmationEmail?.status).toBe("sending");
    expect(await retry()).toBe("wait");
    advance(60_001);
    expect(await retry()).toBe("accepted");
    expect(stored.confirmationEmail?.operationId).toBe(original);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(
      vi.mocked(fetch).mock.calls[1][1]?.body,
    );
  });
  it("po oknie idempotencji wymaga sprawdzenia, nie wysyła drugi raz", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));
    await sendTicketConfirmation(id);
    advance(EMAIL_RETRY_WINDOW_MS);
    expect(await retry()).toBe("review-required");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("maksymalnie pięć prób, z rosnącymi odstępami", async () => {
    vi.mocked(fetch).mockImplementation(
      async () => new Response(null, { status: 503 }),
    );
    await sendTicketConfirmation(id);
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(await retry()).toBe("wait");
      advance(30_000 * 2 ** (attempt - 1));
      expect(await retry()).toBe("retryable");
    }
    advance(1_000_000);
    expect(await retry()).toBe("review-required");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("4xx wymaga diagnozy zamiast kolejnych automatycznych wysyłek", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 422 }));
    expect(await sendTicketConfirmation(id)).toBe("blocked");
    advance(60_000);
    expect(await retry()).toBe("review-required");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("stary nieznany wynik nie jest ponawiany bez snapshotu i klucza", async () => {
    stored.confirmationEmail = { status: "failed", attemptedAt: start };
    expect(await retry()).toBe("review-required");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("ponowienie nieopłaconej rezerwacji nie wysyła maila", async () => {
    stored.status = "held";
    expect(await retry()).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("przyjęcie a doręczenie", () => {
  it.each(["delivered", "bounced"])(
    "obsługuje odbiorcę %s+etykieta i stan z API",
    async (scenario) => {
      stored.email = `${scenario}+etykieta@resend.dev`;
      expect(allowedRecipient(stored.email, false)).toBe(true);
      expect(await sendTicketConfirmation(id)).toBe("accepted");
      expect(emailStatusMessage(stored.confirmationEmail)).toContain(
        "Nie mamy jeszcze potwierdzenia doręczenia",
      );
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ id: "mail-1", last_event: scenario }),
      );
      expect(await checkTicketDelivery(id)).toBe(scenario);
      expect(stored.confirmationEmail?.deliveryStatus).toBe(scenario);
      expect(stored.status).toBe("purchased");
      expect(emailRetryDecision(stored.confirmationEmail!)).toBe("not-needed");
      expect(await retry()).toBe("already-claimed");
      expect(fetch).toHaveBeenCalledTimes(2); // POST plus GET, bez drugiego POST.
    },
  );
  it("późne sent nie cofa bounced ani delivered", async () => {
    await sendTicketConfirmation(id);
    for (const deliveryStatus of ["delivered", "bounced"] as const) {
      stored.confirmationEmail!.deliveryStatus = deliveryStatus;
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ id: "mail-1", last_event: "sent" }),
      );
      await checkTicketDelivery(id);
      expect(stored.confirmationEmail!.deliveryStatus).toBe(deliveryStatus);
    }
  });
  it("awaria odczytu i odpowiedź z obcym id nie deklarują doręczenia", async () => {
    await sendTicketConfirmation(id);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ id: "other", last_event: "delivered" }),
    );
    expect(await checkTicketDelivery(id)).toBe("check-failed");
    expect(stored.confirmationEmail?.deliveryStatus).toBe("unknown");
  });
});
