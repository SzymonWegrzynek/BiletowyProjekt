import { ObjectId } from "mongodb";
import type { WaitlistOffer } from "../../lib/server/offer-mail.ts";
import type { Reservation } from "../../lib/schemas.ts";
import { STUB_WAITLIST_EVENT } from "../../lib/stubs.ts";

export function offerFixture(now = new Date()) {
  const reservationId = new ObjectId();
  const offer: WaitlistOffer = {
    _id: new ObjectId(),
    eventId: STUB_WAITLIST_EVENT._id,
    customerName: "Anna Testowa",
    email: "delivered+oferta@resend.dev",
    status: "offered",
    joinedAt: now,
    reservationId: reservationId.toHexString(),
    offerExpiresAt: new Date(now.getTime() + 120_000),
    mail: { status: "pending" },
  };
  const reservation: Reservation = {
    _id: reservationId,
    eventId: offer.eventId,
    customerName: offer.customerName,
    email: offer.email,
    seatId: "A1",
    status: "held",
    expiresAt: offer.offerExpiresAt!,
    createdAt: now,
    amount: 4500,
  };
  return { offer, reservation, event: { ...STUB_WAITLIST_EVENT } };
}
