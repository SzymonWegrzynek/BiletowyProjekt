import { createHmac } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  verifyResendWebhook,
  createResendWebhookHandler,
} from "@/lib/server/resend-webhook";
import { waitlistOffersCollection } from "@/lib/server/send-offer-mail";
import { getClient, reservationsCollection } from "@/lib/db";
import { offerFixture } from "./fixtures/waitlist-offer";

const secret = `whsec_${Buffer.from("test-secret-no-production-credentials").toString("base64")}`;
function signed(body: string, time = Math.floor(Date.now() / 1000)) {
  const id = "msg_test";
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${time}.${body}`)
    .digest("base64");
  return new Headers({
    "svix-id": id,
    "svix-timestamp": String(time),
    "svix-signature": `v1,${signature}`,
  });
}
afterEach(() => vi.unstubAllEnvs());
it("pasuje do niezależnego wektora testowego dokumentacji Svix", () => {
  const body = '{"event_type":"ping","data":{"success":true}}';
  expect(
    verifyResendWebhook(
      body,
      new Headers({
        "svix-id": "msg_loFOjxBNrRLzqYUf",
        "svix-timestamp": "1731705121",
        "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
      }),
      "whsec_plJ3nmyCDGBKInavdOK15jsl",
      1731705121000,
    ),
  ).toBe("msg_loFOjxBNrRLzqYUf");
});
it("weryfikuje surowe body, rotację podpisów i okno czasu", () => {
  const body = '{"type":"email.bounced"}';
  const headers = signed(body);
  headers.set(
    "svix-signature",
    `v1,bad v2,unknown ${headers.get("svix-signature")}`,
  );
  expect(verifyResendWebhook(body, headers, secret)).toBe("msg_test");
  expect(() => verifyResendWebhook(`${body} `, headers, secret)).toThrow();
  expect(() => verifyResendWebhook(body, new Headers(), secret)).toThrow();
  expect(() =>
    verifyResendWebhook(
      body,
      signed(body, Math.floor(Date.now() / 1000) - 301),
      secret,
    ),
  ).toThrow();
  expect(() =>
    verifyResendWebhook(
      body,
      signed(body, Math.floor(Date.now() / 1000) + 301),
      secret,
    ),
  ).toThrow();
});
it("bez sekretu 503; zły podpis 400 bez dostępu do bazy/B", async () => {
  const mark = vi.fn();
  const handler = createResendWebhookHandler({ markOfferMissed: mark });
  vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
  expect(
    (await handler(new Request("http://test", { method: "POST", body: "{}" })))
      .status,
  ).toBe(503);
  vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
  expect(
    (await handler(new Request("http://test", { method: "POST", body: "{}" })))
      .status,
  ).toBe(400);
  expect(mark).not.toHaveBeenCalled();
});
it("inne podpisane zdarzenie dostaje 200 bez zmian", async () => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
  const body = JSON.stringify({
    type: "domain.updated",
    data: { domain_id: "other" },
  });
  const mark = vi.fn();
  const handler = createResendWebhookHandler({ markOfferMissed: mark });
  expect(
    (
      await handler(
        new Request("http://test", {
          method: "POST",
          body,
          headers: signed(body),
        }),
      )
    ).status,
  ).toBe(200);
  expect(mark).not.toHaveBeenCalled();
});

describe.skipIf(!process.env.MONGODB_URI)(
  "webhook C z atrapą idempotentnego markOfferMissed B",
  () => {
    let fixture: ReturnType<typeof offerFixture>;
    let transitions: number;
    const mark = vi.fn();
    const flush = vi.fn();
    const handler = createResendWebhookHandler({
      markOfferMissed: mark,
      flush,
    });
    const send = (type = "email.bounced", messageId = "offer-message") => {
      const body = JSON.stringify({ type, data: { email_id: messageId } });
      return handler(
        new Request("http://test/api/webhooks/resend", {
          method: "POST",
          body,
          headers: signed(body),
        }),
      );
    };
    beforeEach(async () => {
      vi.clearAllMocks();
      transitions = 0;
      vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
      fixture = offerFixture();
      fixture.offer.mail = { status: "sent", messageId: "offer-message" };
      await waitlistOffersCollection().insertOne(fixture.offer);
      await reservationsCollection().insertOne(fixture.reservation);
      mark.mockImplementation(async () => {
        const result = await waitlistOffersCollection().updateOne(
          { _id: fixture.offer._id, status: "offered" },
          { $set: { status: "missed" } },
        );
        transitions += result.modifiedCount;
      });
      flush.mockResolvedValue([]);
    });
    afterEach(async () => {
      await waitlistOffersCollection().deleteOne({ _id: fixture.offer._id });
      await reservationsCollection().deleteOne({
        _id: fixture.reservation._id,
      });
    });
    afterAll(async () => {
      await getClient().close();
    });
    it("bounce zapisuje stan i woła B; duplikaty mają jeden efekt", async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => send()),
      );
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(transitions).toBe(1);
      expect(mark).toHaveBeenCalledWith(fixture.offer._id.toHexString());
      expect(
        (await waitlistOffersCollection().findOne({ _id: fixture.offer._id }))
          ?.mail?.status,
      ).toBe("bounced");
      expect(flush).toHaveBeenCalledWith(fixture.offer.eventId);
    });
    it("500 z B nie gubi bounce: ponowienie dokańcza pracę", async () => {
      mark.mockRejectedValueOnce(new Error("B database failure"));
      expect((await send()).status).toBe(500);
      expect((await send()).status).toBe(200);
      expect(transitions).toBe(1);
    });
    it("delivered nie przesuwa kolejki i nie cofa bounced", async () => {
      expect((await send("email.delivered")).status).toBe(200);
      expect(mark).not.toHaveBeenCalled();
      expect(
        (await waitlistOffersCollection().findOne({ _id: fixture.offer._id }))
          ?.mail?.status,
      ).toBe("delivered");
      await send();
      await send("email.delivered");
      expect(
        (await waitlistOffersCollection().findOne({ _id: fixture.offer._id }))
          ?.mail?.status,
      ).toBe("bounced");
    });
    it.each(["done", "missed", "left"] as const)(
      "spóźniony bounce dla %s nic nie zmienia",
      async (status) => {
        await waitlistOffersCollection().updateOne(
          { _id: fixture.offer._id },
          { $set: { status } },
        );
        await send();
        expect(mark).not.toHaveBeenCalled();
        expect(
          (await waitlistOffersCollection().findOne({ _id: fixture.offer._id }))
            ?.mail?.status,
        ).toBe("sent");
      },
    );
    it("po czasie albo po opłaceniu nie odbiera oferty/biletu", async () => {
      await waitlistOffersCollection().updateOne(
        { _id: fixture.offer._id },
        { $set: { offerExpiresAt: new Date(0) } },
      );
      await send();
      expect(mark).not.toHaveBeenCalled();
      await waitlistOffersCollection().updateOne(
        { _id: fixture.offer._id },
        { $set: { offerExpiresAt: fixture.offer.offerExpiresAt } },
      );
      await reservationsCollection().updateOne(
        { _id: fixture.reservation._id },
        { $set: { status: "purchased", code: "TEA-PAID" } },
      );
      await send();
      expect(mark).not.toHaveBeenCalled();
      expect(
        (
          await reservationsCollection().findOne({
            _id: fixture.reservation._id,
          })
        )?.code,
      ).toBe("TEA-PAID");
    });
    it("nieznany messageId jest ignorowany", async () => {
      expect((await send("email.bounced", "unknown")).status).toBe(200);
      expect(mark).not.toHaveBeenCalled();
    });
  },
);
