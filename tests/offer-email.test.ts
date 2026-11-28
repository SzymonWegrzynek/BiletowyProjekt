import { expect, it } from "vitest";
import {
  buildOfferEmail,
  offerMailKey,
  offerPaymentUrl,
} from "@/lib/server/offer-mail";
import { offerFixture } from "./fixtures/waitlist-offer";

it.each([
  ["2026-12-15T17:00:00Z", "18:02:00"],
  ["2026-06-15T17:00:00Z", "19:02:00"],
])("mail używa utrwalonej oferty i czasu Warszawy %s", (date, time) => {
  const now = new Date(date);
  const { offer, reservation, event } = offerFixture(now);
  const mail = buildOfferEmail(
    offer,
    reservation,
    event,
    "https://teatr.example",
    now,
  )!;
  expect(mail.text).toContain(event.title);
  expect(mail.text).toContain(time);
  expect(mail.text).toContain("Rząd A, miejsce 1");
  expect(mail.text).toContain(
    `https://teatr.example/rezerwacja/${offer.reservationId}`,
  );
  expect(mail.text).toContain("Oferta nie jest biletem");
  expect(mail.to).toEqual([offer.email]);
  expect(offerMailKey(offer)).toBe(`offer-${offer._id}-${offer.reservationId}`);
});
it("escapuje treść HTML i nie pozwala wstrzyknąć linku z requestu", () => {
  const { offer, reservation, event } = offerFixture();
  const mail = buildOfferEmail(
    offer,
    reservation,
    { ...event, title: '<script>alert("x")</script>' },
    "https://teatr.example",
  )!;
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(() =>
    offerPaymentUrl("javascript:alert(1)", offer.reservationId!),
  ).toThrow();
  expect(() =>
    offerPaymentUrl("https://user:secret@teatr.example", offer.reservationId!),
  ).toThrow();
  expect(() =>
    offerPaymentUrl("https://teatr.example?other=1", offer.reservationId!),
  ).toThrow();
});
it.each(["waiting", "done", "missed", "left"] as const)(
  "brak maila dla %s",
  (status) => {
    const { offer, reservation, event } = offerFixture();
    expect(
      buildOfferEmail(
        { ...offer, status },
        reservation,
        event,
        "https://teatr.example",
      ),
    ).toBeNull();
  },
);
it("odrzuca wygasłą, opłaconą lub niezgodną rezerwację", () => {
  const { offer, reservation, event } = offerFixture();
  expect(
    buildOfferEmail(
      offer,
      { ...reservation, status: "purchased" },
      event,
      "https://teatr.example",
    ),
  ).toBeNull();
  expect(
    buildOfferEmail(
      offer,
      { ...reservation, email: "other@example.com" },
      event,
      "https://teatr.example",
    ),
  ).toBeNull();
  expect(
    buildOfferEmail(
      offer,
      { ...reservation, expiresAt: new Date(0) },
      event,
      "https://teatr.example",
    ),
  ).toBeNull();
  expect(
    buildOfferEmail(
      offer,
      reservation,
      event,
      "https://teatr.example",
      offer.offerExpiresAt,
    ),
  ).toBeNull();
});
