import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ObjectId } from "mongodb";
import { buildOfferEmail } from "../lib/server/offer-mail.ts";
import { offerFixture } from "../tests/fixtures/waitlist-offer.ts";

// Stały moment zapewnia powtarzalny podgląd. Bez bazy i bez wysyłki.
const now = new Date("2026-12-15T17:00:00Z");
const { offer, reservation, event } = offerFixture(now);
offer._id = new ObjectId("6740c0ffee00000000000001");
reservation._id = new ObjectId("6740c0ffee00000000000002");
offer.reservationId = reservation._id.toHexString();
const email = buildOfferEmail(
  offer,
  reservation,
  event,
  "http://localhost:3000",
  now,
);
if (!email) throw new Error("Niepoprawna zaślepka oferty");
await mkdir(resolve("artifacts"), { recursive: true });
await writeFile(
  resolve("artifacts/offer-email-preview.html"),
  email.html,
  "utf8",
);
await writeFile(
  resolve("artifacts/offer-email-preview.txt"),
  email.text,
  "utf8",
);
console.log(
  "Podgląd: artifacts/offer-email-preview.html i .txt. Nie wysłano maila.",
);
