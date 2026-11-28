import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eventsCollection, reservationsCollection, getClient } from "@/lib/db";
import {
  sendOfferMail,
  waitlistOffersCollection,
  sendPendingOfferMails,
} from "@/lib/server/send-offer-mail";
import { offerFixture } from "./fixtures/waitlist-offer";

// Tylko izolowana baza Vitest; prawdziwy Mongo sprawdza atomowy claim.
describe.skipIf(!process.env.MONGODB_URI)(
  "outbox oferty — atomowość i awarie Resend",
  () => {
    let fixture: ReturnType<typeof offerFixture>;
    const fetch = vi.fn();
    const collection = waitlistOffersCollection;
    const read = () => collection().findOne({ _id: fixture.offer._id });
    const retryReady = () =>
      collection().updateOne(
        { _id: fixture.offer._id },
        {
          $set: {
            "mail.nextAttemptAt": new Date(0),
            "mail.leaseUntil": new Date(0),
          },
        },
      );
    beforeEach(async () => {
      vi.clearAllMocks();
      vi.stubEnv("RESEND_API_KEY", "mock");
      vi.stubEnv("RESEND_FROM", "Teatr <onboarding@resend.dev>");
      vi.stubEnv("RESEND_MODE", "test");
      vi.stubEnv("APP_URL", "https://teatr.example");
      fixture = offerFixture();
      fixture.event._id = `offer-mail-${fixture.offer._id}`;
      fixture.offer.eventId = fixture.event._id;
      fixture.reservation.eventId = fixture.event._id;
      await eventsCollection().insertOne(fixture.event);
      await reservationsCollection().insertOne(fixture.reservation);
      await collection().insertOne(fixture.offer);
      fetch
        .mockReset()
        .mockImplementation(async () => Response.json({ id: "message-1" }));
      vi.stubGlobal("fetch", fetch);
    });
    afterEach(async () => {
      await collection().deleteMany({ eventId: fixture.event._id });
      await reservationsCollection().deleteMany({ eventId: fixture.event._id });
      await eventsCollection().deleteOne({ _id: fixture.event._id });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      await getClient().close();
    });
    it("10 równoległych wywołań daje jeden POST i jedno messageId", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          sendOfferMail(fixture.offer._id.toHexString()),
        ),
      );
      expect(results.filter((r) => r === "sent")).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await read())?.mail).toMatchObject({
        status: "sent",
        messageId: "message-1",
        attempts: 1,
      });
      expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
        "already-sent",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each([500, 503, 429])(
      "HTTP %s zachowuje rezerwację i body/key podczas retry",
      async (status) => {
        fetch.mockResolvedValueOnce(
          Response.json(
            { error: "awaria" },
            { status, headers: { "Retry-After": "30" } },
          ),
        );
        expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
          "failed",
        );
        const failed = await read();
        expect(failed?.status).toBe("offered");
        expect(failed?.offerExpiresAt).toEqual(fixture.offer.offerExpiresAt);
        expect(failed?.mail?.nextAttemptAt!.getTime()).toBeGreaterThan(
          Date.now() + 25_000,
        );
        expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
          "wait",
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        await eventsCollection().updateOne(
          { _id: fixture.event._id },
          { $set: { title: "Zmieniony tytuł" } },
        );
        vi.stubEnv("RESEND_FROM", "Inny <onboarding@resend.dev>");
        await retryReady();
        expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
          "sent",
        );
        expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
        expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
          fetch.mock.calls[1][1].headers["Idempotency-Key"],
        );
        expect(
          await reservationsCollection().findOne({
            _id: fixture.reservation._id,
          }),
        ).toEqual(fixture.reservation);
      },
    );
    it("timeout po przyjęciu odtwarza tę samą operację; nie nalicza punktów", async () => {
      const accepted = new Map<string, string>();
      fetch.mockImplementation(async (_url, options) => {
        const key = options.headers["Idempotency-Key"];
        if (accepted.has(key)) return Response.json({ id: accepted.get(key) });
        accepted.set(key, "accepted-before-timeout");
        throw new DOMException("timeout", "TimeoutError");
      });
      expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
        "failed",
      );
      await retryReady();
      expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe("sent");
      expect(accepted.size).toBe(1);
      expect((await read())?.mail?.messageId).toBe("accepted-before-timeout");
      expect(
        await reservationsCollection().findOne({
          _id: fixture.reservation._id,
        }),
      ).toEqual(fixture.reservation);
    });
    it("stały 4xx blokuje spam; po czasie C nie wysyła ani nie zmienia kolejki B", async () => {
      fetch.mockResolvedValueOnce(Response.json({}, { status: 403 }));
      expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
        "blocked",
      );
      await retryReady();
      expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
        "blocked",
      );
      await collection().updateOne(
        { _id: fixture.offer._id },
        { $set: { offerExpiresAt: new Date(0) } },
      );
      expect(await sendOfferMail(fixture.offer._id.toHexString())).toBe(
        "skipped",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await read())?.status).toBe("offered");
    });
    it("nie zmienia cooldown przy kolejnych wyzwalaczach", async () => {
      fetch.mockResolvedValueOnce(
        Response.json({}, { status: 429, headers: { "Retry-After": "120" } }),
      );
      await sendOfferMail(fixture.offer._id.toHexString());
      const next = (await read())?.mail?.nextAttemptAt;
      for (let i = 0; i < 3; i++)
        await sendPendingOfferMails(fixture.offer.eventId);
      expect((await read())?.mail?.nextAttemptAt).toEqual(next);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("po utracie zapisu 2xx lease wygasa i retry odzyskuje identyczny mail", async () => {
      const real = collection();
      // Odtwarzamy trwały stan po przyjęciu przez usługę, bez zapisanego 2xx.
      await sendOfferMail(fixture.offer._id.toHexString());
      await real.updateOne(
        { _id: fixture.offer._id },
        {
          $set: { "mail.status": "pending", "mail.leaseUntil": new Date(0) },
          $unset: { "mail.messageId": "", "mail.acceptedAt": "" },
        },
      );
      await sendOfferMail(fixture.offer._id.toHexString());
      expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
      expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
        fetch.mock.calls[1][1].headers["Idempotency-Key"],
      );
    });
    it("batch jest ograniczony do trzech ofert", async () => {
      const offers = Array.from({ length: 4 }, (_, index) => {
        const f = offerFixture();
        f.offer.eventId = fixture.event._id;
        f.reservation.eventId = fixture.event._id;
        f.reservation.seatId = `A${index + 2}`;
        return f;
      });
      await collection().insertMany(offers.map((f) => f.offer));
      await reservationsCollection().insertMany(
        offers.map((f) => f.reservation),
      );
      expect(await sendPendingOfferMails(fixture.event._id, 100)).toHaveLength(
        3,
      );
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  },
);
