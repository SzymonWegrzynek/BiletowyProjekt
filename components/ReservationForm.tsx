"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { formatSeat } from "@/lib/format";
import { createReservationSchema } from "@/lib/schemas";

type Field = "customerName" | "email";
type FieldErrors = Partial<Record<Field, string>>;

const SEAT_TAKEN_MESSAGE = "Ktoś był szybszy — wybierz inne miejsce";
const GENERIC_MESSAGE = "Nie udało się zarezerwować miejsca. Spróbuj ponownie.";

type Props = {
  eventId: string;
  seatId: string;
  // Po 409: widownia odświeża takenSeats i pozwala wybrać inne miejsce.
  onSeatTaken?: () => void;
};

function validate(data: unknown): FieldErrors {
  const parsed = createReservationSchema.safeParse(data);
  if (parsed.success) return {};
  const { fieldErrors } = z.flattenError(parsed.error);
  return {
    customerName: fieldErrors.customerName?.[0],
    email: fieldErrors.email?.[0],
  };
}

export function ReservationForm({ eventId, seatId, onSeatTaken }: Props) {
  const router = useRouter();
  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const body = { eventId, seatId, customerName, email };
    const errors = validate(body);
    setFieldErrors(errors);
    setFormError(null);
    if (errors.customerName || errors.email) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);

      if (res.status === 201 && typeof json?.reservationId === "string") {
        // Przycisk zostaje zablokowany do końca nawigacji.
        router.push(`/rezerwacja/${json.reservationId}`);
        return;
      }

      if (res.status === 409) {
        setFormError(SEAT_TAKEN_MESSAGE);
        onSeatTaken?.();
      } else if (res.status === 400) {
        // Serwer nie mówi, którego pola dotyczy błąd — przypisujemy go
        // lokalną walidacją, a gdy ta nic nie znajdzie, pokazujemy ogólnie.
        const local = validate(body);
        if (local.customerName || local.email) setFieldErrors(local);
        else setFormError(json?.error ?? GENERIC_MESSAGE);
      } else {
        setFormError(json?.error ?? GENERIC_MESSAGE);
      }
    } catch {
      setFormError(GENERIC_MESSAGE);
    }
    setSubmitting(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-lg border border-gray-200 p-4"
    >
      <h2 className="text-lg font-semibold">{formatSeat(seatId)}</h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="customerName" className="text-sm font-medium">
          Imię
        </label>
        <input
          id="customerName"
          name="customerName"
          autoComplete="given-name"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          disabled={submitting}
          aria-invalid={Boolean(fieldErrors.customerName)}
          aria-describedby={
            fieldErrors.customerName ? "customerName-error" : undefined
          }
          className="rounded border border-gray-300 px-3 py-2 aria-invalid:border-red-600"
        />
        {fieldErrors.customerName && (
          <p id="customerName-error" className="text-sm text-red-600">
            {fieldErrors.customerName}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium">
          E-mail
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? "email-error" : undefined}
          className="rounded border border-gray-300 px-3 py-2 aria-invalid:border-red-600"
        />
        {fieldErrors.email && (
          <p id="email-error" className="text-sm text-red-600">
            {fieldErrors.email}
          </p>
        )}
      </div>

      {formError && (
        <p role="alert" className="text-sm text-red-600">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Rezerwuję…" : "Rezerwuję"}
      </button>
    </form>
  );
}
