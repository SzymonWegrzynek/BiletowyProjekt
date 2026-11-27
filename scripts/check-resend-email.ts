import { readResendEvent } from "../lib/server/resend.ts";

const id = process.argv[2];
if (!id) {
  console.error("Użycie: pnpm email:inspect <id-wiadomości-Resend>");
  process.exitCode = 1;
} else {
  try {
    console.log("Ostatnie zdarzenie Resend:", await readResendEvent(id));
    console.log(
      "Tylko delivered potwierdza doręczenie do serwera odbiorcy. sent oznacza przyjęcie do wysyłki.",
    );
  } catch {
    console.error(
      "Nie udało się odczytać wiadomości. Sprawdź id i uprawnienia klucza Resend.",
    );
    process.exitCode = 1;
  }
}
