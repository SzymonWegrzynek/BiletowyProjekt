import { createHash } from "node:crypto";
import type { Event, Reservation } from "@/lib/schemas";
import { createReservationSchema, seatIdSchema } from "../schemas.ts";
import { settlementRows } from "../reservation-summary.ts";
import { formatSeat } from "../format.ts";

export type TicketEmail = {
  to: string[];
  subject: string;
  text: string;
  html: string;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );

// Wyłącznie serwer: Node crypto uniemożliwia użycie modułu w kliencie.
export function ticketEmailKey(reservation: Reservation) {
  const digest = createHash("sha256")
    .update(`${reservation._id.toHexString()}:${reservation.code}`)
    .digest("hex");
  return `ticket-confirmation/${digest}`;
}

export function buildTicketEmail(
  reservation: Reservation,
  event: Event,
): TicketEmail | null {
  const settlement = settlementRows(reservation);
  const email = createReservationSchema.shape.email.safeParse(
    reservation.email,
  );
  if (
    reservation.status !== "purchased" ||
    !reservation.code?.trim() ||
    !settlement ||
    !email.success ||
    event._id !== reservation.eventId ||
    !seatIdSchema.safeParse(reservation.seatId).success
  )
    return null;
  const rows = [
    ["Spektakl", event.title],
    ["Termin", `${event.date}, ${event.time}`],
    ["Scena", event.stage],
    ["Miejsce", formatSeat(reservation.seatId)],
    ["Kod biletu", reservation.code],
    ...settlement,
  ];
  return {
    to: [email.data],
    subject: `Twój bilet ${reservation.code.replace(/[\r\n]/g, " ")}`,
    text: `Zakup potwierdzony\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}`,
    html: `<!doctype html><html lang="pl"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#111827"><h1>Zakup potwierdzony</h1><table>${rows.map(([label, value]) => `<tr><th scope="row" style="text-align:left;padding:8px">${escapeHtml(label)}</th><td style="padding:8px">${escapeHtml(value)}</td></tr>`).join("")}</table></body></html>`,
  };
}
