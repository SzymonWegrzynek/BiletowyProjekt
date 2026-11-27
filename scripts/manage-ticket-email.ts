import { ObjectId } from "mongodb";
import { getClient, reservationsCollection } from "../lib/db.ts";
import { reservationIdSchema } from "../lib/schemas.ts";
import { emailRetryDecision, emailStatusMessage } from "../lib/email-state.ts";
import {
  sendTicketConfirmation,
  checkTicketDelivery,
} from "../lib/server/send-ticket-confirmation.ts";

const [action, id] = process.argv.slice(2);
if (
  !["status", "retry", "check"].includes(action) ||
  !reservationIdSchema.safeParse(id).success
) {
  console.error("Użycie: pnpm email:manage status|retry|check <reservationId>");
  process.exitCode = 1;
} else {
  try {
    if (action === "retry")
      console.log(
        "Wynik ponowienia:",
        await sendTicketConfirmation(id, { retry: true }),
      );
    if (action === "check")
      console.log("Wynik sprawdzenia:", await checkTicketDelivery(id));
    const reservation = await reservationsCollection().findOne({
      _id: new ObjectId(id),
    });
    if (!reservation || reservation.status !== "purchased")
      throw new Error("Brak potwierdzonego zakupu");
    const state = reservation.confirmationEmail;
    console.log(emailStatusMessage(state));
    console.log(
      JSON.stringify(
        {
          status: state?.status ?? "not-started",
          operationId: state?.operationId,
          providerId: state?.providerId,
          attempts: state?.attempts,
          lastError: state?.lastError,
          providerEvent: state?.providerEvent,
          deliveryStatus: state?.deliveryStatus ?? "unknown",
          deliveryCheckedAt: state?.deliveryCheckedAt,
          nextAttemptAt: state?.nextAttemptAt,
          retry: state ? emailRetryDecision(state) : "initial-send",
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Nie udało się odczytać operacji. Sprawdź id zakupu, konfigurację i dostęp do bazy.",
    );
    process.exitCode = 1;
  } finally {
    await getClient().close();
  }
}
