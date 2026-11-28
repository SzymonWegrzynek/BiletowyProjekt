import { createHash } from "node:crypto";
import type { TicketEmail } from "./ticket-email";

export function resendConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    live: process.env.RESEND_MODE === "live" && process.env.NODE_ENV !== "test",
  };
}

export function allowedRecipient(email: string, live: boolean) {
  return (
    live || /^(?:delivered|bounced)(?:\+[a-z0-9_-]+)?@resend\.dev$/i.test(email)
  );
}

export class ResendSendError extends Error {
  readonly retryable: boolean;
  readonly kind: string;
  constructor(
    kind: string,
    retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super("Resend nie potwierdził przyjęcia wiadomości");
    this.name = "ResendSendError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export async function sendResendRequest(
  requestBody: string,
  key: string,
  options: { timeoutMs?: number } = {},
) {
  const config = resendConfig();
  if (!config) throw new Error("Resend nie jest skonfigurowany");
  const email = JSON.parse(requestBody);
  if (
    !Array.isArray(email.to) ||
    !email.to.length ||
    !email.to.every(
      (to: unknown) =>
        typeof to === "string" && allowedRecipient(to, config.live),
    )
  )
    throw new Error("Tryb testowy wymaga odbiorcy Resend");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: requestBody,
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
  } catch {
    throw new ResendSendError("timeout_or_network", true);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ResendSendError(
      `http_${response.status}`,
      response.status >= 500 || response.status === 429,
      retryAfterMilliseconds(response.headers.get("Retry-After")),
    );
  if (typeof data?.id !== "string" || !data.id.trim())
    throw new ResendSendError("invalid_response", true);
  return data.id as string;
}

export function retryAfterMilliseconds(value: string | null) {
  if (!value) return undefined;
  const milliseconds = /^\d+(\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

export async function sendWithResend(email: TicketEmail, key: string) {
  const config = resendConfig();
  if (!config) throw new Error("Resend nie jest skonfigurowany");
  return sendResendRequest(
    JSON.stringify({ from: config.from, ...email }),
    key,
  );
}

export async function readResendEvent(providerId: string) {
  const config = resendConfig();
  if (!config) throw new Error("Resend nie jest skonfigurowany");
  const response = await fetch(
    `https://api.resend.com/emails/${encodeURIComponent(providerId)}`,
    {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    },
  );
  const data = await response.json().catch(() => null);
  if (
    !response.ok ||
    data?.id !== providerId ||
    typeof data?.last_event !== "string"
  )
    throw new Error("Nie udało się sprawdzić doręczenia");
  return data.last_event as string;
}

// Klucz testu nie zawiera adresów ani treści wiadomości.
export function testEmailKey(id: string) {
  return `ticket-test/${createHash("sha256").update(id).digest("hex")}`;
}
