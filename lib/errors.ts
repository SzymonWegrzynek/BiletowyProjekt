const ERRORS = {
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
} as const;

export type ErrorCode = keyof typeof ERRORS;

// Format z kontraktu: { error: "komunikat po polsku", code: "KOD" }.
export function apiError(code: ErrorCode, message?: string): Response {
  const { status, message: defaultMessage } = ERRORS[code];
  return Response.json({ error: message ?? defaultMessage, code }, { status });
}
