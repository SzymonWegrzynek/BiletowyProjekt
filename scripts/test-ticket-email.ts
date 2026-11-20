import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTicketEmail } from "../lib/server/ticket-email.ts";
import { sendWithResend, testEmailKey } from "../lib/server/resend.ts";
import {
  paidEvent,
  paidReservation,
} from "../tests/fixtures/paid-reservation.ts";

const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const scenario = option("--scenario") ?? "delivered";
const label = option("--label") ?? "bilet";
if (
  !["delivered", "bounced"].includes(scenario) ||
  !/^[a-z0-9_-]+$/i.test(label)
)
  throw new Error(
    "Użyj --scenario delivered|bounced oraz --label z liter, cyfr, _ lub -",
  );
// Wyłącznie fikcyjny opłacony bilet i odbiorca testowy Resend, bez bazy.
const email = buildTicketEmail(
  { ...paidReservation, email: `${scenario}+${label}@resend.dev` },
  paidEvent,
);
if (!email) throw new Error("Niepoprawna zaślepka biletu");
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, "ticket-email-preview.html"),
  email.html,
  "utf8",
);
await writeFile(
  resolve(directory, "ticket-email-preview.txt"),
  email.text,
  "utf8",
);
console.log("Podgląd zapisany w artifacts/ticket-email-preview.html i .txt");
if (process.argv.includes("--send")) {
  const id = await sendWithResend(
    email,
    testEmailKey(
      `${scenario}:${label}:${option("--operation") ?? randomUUID()}`,
    ),
  );
  console.log(`Resend przyjął wiadomość testową: ${id}`);
}
