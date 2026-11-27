import { getClient } from "../lib/db.ts";
import {
  finishPendingLoyaltyWork,
  listPendingLoyaltyWork,
} from "../lib/loyalty-recovery.ts";

// pnpm loyalty:pending            — pokazuje zaległe rozliczenia punktów
// pnpm loyalty:pending --finish   — dokańcza je (bezpieczne do ponawiania)
// --email=jan@example.com          — tylko jeden klient
async function main() {
  const finish = process.argv.includes("--finish");
  const emailArg = process.argv.find((arg) => arg.startsWith("--email="));
  const scope = emailArg
    ? { email: emailArg.slice("--email=".length).trim() }
    : {};
  try {
    const work = await listPendingLoyaltyWork(scope);
    console.info(`Nagrody za bilety do dopisania: ${work.rewards.length}`);
    for (const r of work.rewards) {
      console.info(
        `  rezerwacja ${r.reservationId}: ${r.pointsEarned} pkt dla ${r.email}`,
      );
    }
    console.info(`Niedokończone operacje: ${work.operations.length}`);
    for (const o of work.operations) {
      console.info(
        `  ${o.id} (${o.status}, ${o.points} pkt, prób: ${o.attempts})` +
          (o.autoFinish ? "" : " — potrącenie, rozstrzyga ścieżka płatności") +
          (o.lastError ? `\n    ostatni błąd: ${o.lastError}` : ""),
      );
    }
    console.info(`Odrzucone przez Voucherify: ${work.failed.length}`);
    for (const f of work.failed) {
      console.info(`  ${f.id} (${f.points} pkt): ${f.lastError ?? ""}`);
    }

    console.info(
      `Płatności z punktami bez zapłaty ani zwrotu: ${work.attempts.length}`,
    );
    for (const a of work.attempts) {
      console.info(
        `  próba ${a.id} (${a.status}, ${a.points} pkt, rezerwacja ${a.reservationId}` +
          (a.sessionId ? `, sesja ${a.sessionId}` : "") +
          ")" +
          (a.lastError ? `\n    ostatni błąd: ${a.lastError}` : ""),
      );
    }

    if (finish) {
      const report = await finishPendingLoyaltyWork(scope);
      console.info(
        `Dokończone: ${report.finished}, w toku: ${report.waiting}, błędy: ${report.errors}` +
          (report.stoppedByLimit
            ? " — przerwane na limicie zapytań Voucherify, uruchom ponownie później"
            : ""),
      );
    }
  } finally {
    await getClient().close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
