export type EmailOperation = {
  // sent/failed to rekordy sprzed migracji, nie wolno ich ponawiać w ciemno.
  status:
    | "sending"
    | "accepted"
    | "retryable"
    | "blocked"
    | "review_required"
    | "sent"
    | "failed";
  attemptedAt: Date;
  operationId?: string;
  requestBody?: string;
  firstAttemptAt?: Date;
  attempts?: number;
  attemptToken?: string;
  leaseUntil?: Date;
  nextAttemptAt?: Date;
  acceptedAt?: Date;
  sentAt?: Date;
  providerId?: string;
  lastError?: string;
  deliveryStatus?:
    | "unknown"
    | "delivered"
    | "bounced"
    | "delayed"
    | "failed"
    | "complained"
    | "suppressed";
  providerEvent?: string;
  deliveryCheckedAt?: Date;
};

export const EMAIL_MAX_ATTEMPTS = 5;
// Resend pamięta klucz 24 h; godzinny margines chroni granicę okna.
export const EMAIL_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function emailRetryDecision(
  state: EmailOperation,
  now = new Date(),
): "allowed" | "wait" | "review" | "not-needed" {
  if (
    state.providerId ||
    state.status === "accepted" ||
    state.status === "sent"
  )
    return "not-needed";
  if (!["sending", "retryable"].includes(state.status)) return "review";
  if (
    !state.operationId ||
    !state.requestBody ||
    !state.firstAttemptAt ||
    !state.attempts ||
    !state.attemptToken
  )
    return "review";
  const elapsed = now.getTime() - state.firstAttemptAt.getTime();
  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed >= EMAIL_RETRY_WINDOW_MS ||
    state.attempts >= EMAIL_MAX_ATTEMPTS
  )
    return "review";
  if (state.status === "sending" && !state.leaseUntil) return "review";
  if (
    (state.leaseUntil && state.leaseUntil > now) ||
    (state.nextAttemptAt && state.nextAttemptAt > now)
  )
    return "wait";
  return "allowed";
}

export function emailStatusMessage(state?: EmailOperation) {
  if (state?.deliveryStatus === "delivered")
    return "Serwer pocztowy odbiorcy potwierdził doręczenie wiadomości.";
  if (
    ["bounced", "complained", "suppressed", "failed"].includes(
      state?.deliveryStatus ?? "",
    )
  )
    return "Wiadomość została odrzucona lub jej wysyłkę wstrzymano. Skontaktuj się z obsługą w sprawie adresu e-mail. Bilet na tej stronie pozostaje ważny.";
  if (state?.deliveryStatus === "delayed")
    return "Doręczenie wiadomości jest opóźnione. Bilet na tej stronie pozostaje ważny.";
  if (state?.status === "accepted" || state?.status === "sent")
    return "Wiadomość została przyjęta do wysyłki. Nie mamy jeszcze potwierdzenia doręczenia.";
  if (state?.status === "sending")
    return "Trwa wysyłka lub sprawdzanie jej wyniku. Bilet na tej stronie pozostaje ważny.";
  if (state?.status === "retryable")
    return "Nie potwierdzono wysyłki wiadomości. Skontaktuj się z obsługą, aby sprawdzić możliwość ponowienia. Bilet na tej stronie pozostaje ważny.";
  if (state)
    return "Wysyłka wiadomości wymaga sprawdzenia przez obsługę. Bilet na tej stronie pozostaje ważny.";
  return "Brak potwierdzenia wysyłki wiadomości. Bilet jest dostępny na tej stronie niezależnie od poczty.";
}
