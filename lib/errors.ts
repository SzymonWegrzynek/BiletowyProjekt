const ERRORS = {
  RESERVATION_UNAVAILABLE: {
    status: 503,
    message: "Nie udało się odczytać rezerwacji. Spróbuj ponownie.",
  },
  VALIDATION_ERROR: { status: 400, message: "Niepoprawne dane" },
  NOT_FOUND: { status: 404, message: "Nie znaleziono" },
  SEAT_TAKEN: {
    status: 409,
    message: "Ktoś był szybszy — wybierz inne miejsce",
  },
  RESERVATION_EXPIRED: {
    status: 410,
    message: "Rezerwacja wygasła, miejsce wróciło do puli",
  },
  ALREADY_PAID: {
    status: 409,
    message: "Ta rezerwacja jest już opłacona",
  },
  INSUFFICIENT_POINTS: {
    status: 409,
    message: "Masz za mało punktów. Odśwież saldo i wybierz mniej punktów.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Za dużo prób rezerwacji. Spróbuj ponownie za chwilę.",
  },
  PAYMENT_UNAVAILABLE: {
    status: 503,
    message: "Płatności chwilowo niedostępne, spróbuj za chwilę",
  },
  LOYALTY_UNAVAILABLE: {
    status: 503,
    message: "Usługa punktów jest chwilowo niedostępna. Spróbuj ponownie.",
  },
} as const;

export type ErrorCode = keyof typeof ERRORS;

// Format z kontraktu: { error: "komunikat po polsku", code: "KOD" }.
export function apiError(
  code: ErrorCode,
  message?: string,
  headers?: HeadersInit,
): Response {
  const { status, message: defaultMessage } = ERRORS[code];
  return Response.json(
    { error: message ?? defaultMessage, code },
    { status, headers },
  );
}
