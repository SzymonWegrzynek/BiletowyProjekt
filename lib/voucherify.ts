import { z } from "zod";

// Voucherify to zewnętrzny program lojalnościowy i jedyne źródło prawdy o
// saldzie punktów (klient może zbierać punkty także w innych kanałach).
// Rozmawiamy z nim zwykłym fetch — bez SDK, żeby nie dokładać zależności.

// Zapytanie nie może wisieć: Voucherify jest po drodze do odczytu salda
// i do rozliczenia zakupu.
export const VOUCHERIFY_TIMEOUT_MS = 5_000;

// Po ilu sekundach klient może spróbować ponownie (Retry-After przy 503).
export const LOYALTY_RETRY_AFTER_SECONDS = 5;

const DEFAULT_API_URL = "https://api.voucherify.io";

// Czy zmiana salda mogła dojść do skutku, mimo że nie dostaliśmy odpowiedzi.
// - "not_applied": Voucherify na pewno nic nie zmienił (brak konfiguracji,
//   limit zapytań, odrzucony klucz) — można bezpiecznie ponowić.
// - "unknown": timeout, zerwane połączenie, 5xx — zmiana mogła się wykonać.
//   Przed ponowieniem trzeba to sprawdzić, nie powtarzać w ciemno.
export type LoyaltyOutcome = "not_applied" | "unknown";

// „Program lojalnościowy chwilowo niedostępny” → 503 LOYALTY_UNAVAILABLE.
// Nigdy nie zamieniamy tego na saldo 0.
export class LoyaltyUnavailableError extends Error {
  constructor(
    message: string,
    readonly outcome: LoyaltyOutcome,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// Voucherify odrzucił zapytanie (4xx inne niż limit i autoryzacja) — np.
// nieznana karta albo za mało punktów. Zmiana na pewno się nie wykonała.
export class VoucherifyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly key: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type VoucherifyConfig = {
  apiUrl: string;
  appId: string;
  secretKey: string;
  campaignId: string;
};

// Klucze tylko po stronie serwera (bez NEXT_PUBLIC_). Brak konfiguracji to
// błąd po naszej stronie: szczegóły idą do logów, klient dostaje 503.
function getConfig(): VoucherifyConfig {
  const appId = process.env.VOUCHERIFY_APP_ID?.trim();
  const secretKey = process.env.VOUCHERIFY_SECRET_KEY?.trim();
  const campaignId = process.env.VOUCHERIFY_CAMPAIGN_ID?.trim();
  if (!appId || !secretKey || !campaignId) {
    throw new LoyaltyUnavailableError(
      "Brak zmiennych VOUCHERIFY_APP_ID / VOUCHERIFY_SECRET_KEY / VOUCHERIFY_CAMPAIGN_ID",
      "not_applied",
    );
  }
  const apiUrl = (
    process.env.VOUCHERIFY_API_URL?.trim() || DEFAULT_API_URL
  ).replace(/\/+$/, "");
  return { apiUrl, appId, secretKey, campaignId };
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

async function request(
  method: "GET" | "POST",
  path: (campaignId: string) => string,
  body?: unknown,
): Promise<unknown> {
  const config = getConfig();
  const url = `${config.apiUrl}${path(encodeURIComponent(config.campaignId))}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-App-Id": config.appId,
        "X-App-Token": config.secretKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(VOUCHERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout albo zerwane połączenie: nie wiemy, czy Voucherify coś zrobił.
    throw new LoyaltyUnavailableError(
      `Voucherify nie odpowiada (${method} ${url})`,
      "unknown",
      undefined,
      { cause: error },
    );
  }

  if (response.status === 429) {
    throw new LoyaltyUnavailableError(
      "Voucherify: przekroczony limit zapytań",
      "not_applied",
      retryAfter(response),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new LoyaltyUnavailableError(
      `Voucherify odrzucił klucze API (${response.status})`,
      "not_applied",
    );
  }
  if (response.status >= 500) {
    throw new LoyaltyUnavailableError(
      `Voucherify ${response.status} (${method} ${url})`,
      "unknown",
      retryAfter(response),
    );
  }

  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = z
      .object({ key: z.string().optional(), message: z.string().optional() })
      .safeParse(data);
    throw new VoucherifyRequestError(
      response.status,
      error.success ? error.data.key : undefined,
      `Voucherify ${response.status}: ${error.success ? (error.data.message ?? "") : ""}`,
    );
  }
  return data;
}

// Karta lojalnościowa klienta: kod karty i dostępne punkty
// (loyalty_card.balance = zebrane − wygasłe − odjęte − wydane).
const memberSchema = z.object({
  code: z.string().min(1),
  loyalty_card: z.object({ balance: z.number().int() }),
});

export type LoyaltyCard = { cardCode: string; balance: number };

function parseCard(data: unknown): LoyaltyCard {
  const parsed = memberSchema.safeParse(data);
  if (!parsed.success) {
    throw new LoyaltyUnavailableError(
      "Voucherify zwrócił nieoczekiwaną odpowiedź karty",
      "unknown",
    );
  }
  return {
    cardCode: parsed.data.code,
    balance: parsed.data.loyalty_card.balance,
  };
}

// Dołączenie klienta (identyfikowanego e-mailem) do kampanii lojalnościowej.
// W kampaniach lojalnościowych Voucherify join_once jest zawsze włączone:
// klient ma w kampanii jedną kartę.
export async function joinLoyaltyProgram(email: string): Promise<LoyaltyCard> {
  const data = await request(
    "POST",
    (campaignId) => `/v1/loyalties/${campaignId}/members`,
    { customer: { source_id: email, email } },
  );
  return parseCard(data);
}

// Aktualne saldo karty prosto z Voucherify.
export async function getLoyaltyCard(cardCode: string): Promise<LoyaltyCard> {
  const data = await request(
    "GET",
    (campaignId) =>
      `/v1/loyalties/${campaignId}/members/${encodeURIComponent(cardCode)}`,
  );
  return parseCard(data);
}

const balanceSchema = z.object({ balance: z.number().int() });

// Dodanie (points > 0) albo odjęcie (points < 0) punktów. Voucherify nie ma
// klucza idempotencji — każde wywołanie to nowa transakcja. Dlatego source_id
// = nasz identyfikator operacji: po nim da się potem znaleźć transakcję.
// Zwraca saldo po zmianie, jeśli Voucherify je podał.
export async function adjustLoyaltyBalance(
  cardCode: string,
  points: number,
  { sourceId, reason }: { sourceId: string; reason: string },
): Promise<{ balance?: number }> {
  const data = await request(
    "POST",
    (campaignId) =>
      `/v1/loyalties/${campaignId}/members/${encodeURIComponent(cardCode)}/balance`,
    { points, source_id: sourceId, reason },
  );
  const parsed = balanceSchema.safeParse(data);
  return parsed.success ? { balance: parsed.data.balance } : {};
}

const transactionsPageSchema = z.object({
  data: z.array(z.object({ id: z.string(), source_id: z.string().nullish() })),
  has_more: z.boolean().optional(),
  more_starting_after: z.string().nullish(),
});

// Ile stron historii karty (po 100 transakcji) przeglądamy, szukając
// własnej operacji. Szukamy od najnowszych, a niepewna operacja jest świeża.
const TRANSACTION_PAGES = 5;

// Czy na karcie jest już transakcja z naszym source_id (= id operacji).
// Tak rozstrzygamy operację po timeoucie: czy Voucherify ją wykonał, zanim
// spróbujemy drugi raz. Filtr API nie obejmuje source_id — przeglądamy listę.
export async function hasLoyaltyTransaction(
  cardCode: string,
  sourceId: string,
): Promise<boolean> {
  let startingAfter: string | undefined;
  for (let page = 0; page < TRANSACTION_PAGES; page++) {
    const query = new URLSearchParams({ limit: "100", order: "-id" });
    if (startingAfter) query.set("starting_after_id", startingAfter);
    const data = await request(
      "GET",
      (campaignId) =>
        `/v1/loyalties/${campaignId}/members/${encodeURIComponent(cardCode)}/transactions?${query}`,
    );
    const parsed = transactionsPageSchema.safeParse(data);
    if (!parsed.success) {
      throw new LoyaltyUnavailableError(
        "Voucherify zwrócił nieoczekiwaną listę transakcji",
        "unknown",
      );
    }
    if (parsed.data.data.some((t) => t.source_id === sourceId)) return true;
    if (!parsed.data.has_more || !parsed.data.more_starting_after) {
      return false;
    }
    startingAfter = parsed.data.more_starting_after;
  }
  // Historia dłuższa niż przeglądamy — nie zgadujemy, operacja zostaje
  // nierozstrzygnięta do ręcznego sprawdzenia.
  throw new LoyaltyUnavailableError(
    `Nie znaleziono ${sourceId} w ${TRANSACTION_PAGES} stronach historii karty`,
    "unknown",
  );
}
