import type { ObjectId } from "mongodb";
import type { Event, Reservation } from "../schemas.ts";
import { formatSeat } from "../format.ts";
import { joinWaitlistSchema, waitlistIdSchema } from "../waitlist.ts";

// Roboczy kontrakt B → C z Trello. Id rezerwacji jest stringiem jak w API.
export type WaitlistOffer = {
  _id: ObjectId;
  eventId: string;
  email: string;
  customerName: string;
  status: "waiting" | "offered" | "done" | "missed" | "left";
  joinedAt: Date;
  reservationId?: string;
  offerExpiresAt?: Date;
  mail?: OfferMailState;
};
export type OfferMailState = {
  status: "pending" | "failed" | "sent" | "delivered" | "bounced";
  messageId?: string;
  operationId?: string;
  requestBody?: string;
  firstAttemptAt?: Date;
  attempts?: number;
  attemptToken?: string;
  leaseUntil?: Date;
  nextAttemptAt?: Date;
  retryable?: boolean;
  lastError?: string;
  acceptedAt?: Date;
  // Bounce jest przetwarzany ponownie, jeżeli B poprzednio zgłosił błąd.
  bounceHandledAt?: Date;
};
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function offerMailKey(offer: WaitlistOffer) {
  return `offer-${offer._id.toHexString()}-${offer.reservationId}`;
}
export function offerPaymentUrl(appUrl: string, reservationId: string) {
  const url = new URL(appUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Niepoprawny APP_URL");
  return `${url.origin}/rezerwacja/${encodeURIComponent(reservationId)}`;
}
export function buildOfferEmail(
  offer: WaitlistOffer,
  reservation: Reservation,
  event: Event,
  appUrl: string,
  now = new Date(),
) {
  if (
    offer.status !== "offered" ||
    reservation.status !== "held" ||
    !offer.reservationId ||
    !waitlistIdSchema.safeParse(offer.reservationId).success ||
    reservation._id.toHexString() !== offer.reservationId ||
    offer.eventId !== event._id ||
    reservation.eventId !== event._id ||
    !offer.offerExpiresAt ||
    offer.offerExpiresAt.getTime() !== reservation.expiresAt.getTime() ||
    !(offer.offerExpiresAt > now) ||
    offer.email.trim().toLowerCase() !==
      reservation.email.trim().toLowerCase() ||
    !joinWaitlistSchema.safeParse(offer).success
  )
    return null;
  const url = offerPaymentUrl(appUrl, offer.reservationId);
  const deadline = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "long",
    timeStyle: "long",
  }).format(offer.offerExpiresAt);
  const rows = [
    ["Spektakl", event.title],
    ["Termin", `${event.date}, ${event.time}`],
    ["Scena", event.stage],
    ["Miejsce", formatSeat(reservation.seatId)],
    ["Oferta ważna do", `${deadline} (Europe/Warsaw)`],
  ];
  return {
    to: [offer.email],
    subject: "Mamy dla Ciebie miejsce — oferta z listy oczekujących",
    text: `Mamy dla Ciebie miejsce\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nZapłać: ${url}\nMożesz użyć punktów. Oferta nie jest biletem. Po upływie czasu nieopłacone miejsce przechodzi dalej.`,
    html: `<!doctype html><html lang="pl"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#111827"><h1>Mamy dla Ciebie miejsce</h1><table>${rows.map(([label, value]) => `<tr><th scope="row" style="text-align:left;padding:8px">${escape(label)}</th><td style="padding:8px">${escape(value)}</td></tr>`).join("")}</table><p><a href="${escape(url)}">Zapłać za miejsce</a></p><p>Możesz użyć punktów. Oferta nie jest biletem. Po upływie czasu nieopłacone miejsce przechodzi dalej.</p></body></html>`,
  };
}
