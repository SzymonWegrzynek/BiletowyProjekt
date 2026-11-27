"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Spinner } from "@/components/Spinner";
import { formatSeat } from "@/lib/format";
import { createReservationSchema } from "@/lib/schemas";
import { LoyaltyBalance } from "@/components/LoyaltyBalance";

type Field = "customerName" | "email";
type FieldErrors = Partial<Record<Field, string>>;

const SEAT_TAKEN_MESSAGE = "Ktoś był szybszy — wybierz inne miejsce";
const GENERIC_MESSAGE = "Nie udało się zarezerwować miejsca. Spróbuj ponownie.";

type Props = {
  eventId: string;
  seatId: string;
  // Po 409: widownia odświeża takenSeats i pozwala wybrać inne miejsce.
  onSeatTaken?: () => void;
  // Po 201/200, tuż przed przejściem na /rezerwacja/[id].
  onReserved?: () => void;
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

export function ReservationForm({
  eventId,
  seatId,
  onSeatTaken,
  onReserved,
}: Props) {
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

      // 201 = nowa rezerwacja, 200 = ponowiony request zwrócił tę samą.
      if (res.ok && typeof json?.reservationId === "string") {
        // Przycisk zostaje zablokowany do końca nawigacji.
        onReserved?.();
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
    <form onSubmit={handleSubmit} noValidate className="card flex flex-col p-7">
      <p className="label">Twój wybór</p>
      <h2 className="title mt-2 text-3xl">{formatSeat(seatId)}</h2>

      <div className="mt-8 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label htmlFor="customerName" className="text-sm font-medium">
            Imię
          </label>
          <input
            id="customerName"
            name="customerName"
            autoComplete="given-name"
            placeholder="np. Anna"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(fieldErrors.customerName)}
            aria-describedby={
              fieldErrors.customerName ? "customerName-error" : undefined
            }
            className="field"
          />
          {fieldErrors.customerName && (
            <p id="customerName-error" className="text-sm text-cinnabar">
              {fieldErrors.customerName}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="text-sm font-medium">
            E-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="anna@przyklad.pl"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
            className="field"
          />
          {fieldErrors.email && (
            <p id="email-error" className="text-sm text-cinnabar">
              {fieldErrors.email}
            </p>
          )}
        </div>
      </div>

      <LoyaltyBalance email={email} />

      {formError && (
        <p role="alert" className="alert mt-6">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="btn-primary mt-8 w-full"
      >
        {submitting && <Spinner />}
        {submitting ? "Rezerwuję…" : "Rezerwuję"}
      </button>
      <p className="mt-4 text-center text-xs text-muted">
        Miejsce czeka na Ciebie przez ograniczony czas.
      </p>
    </form>
  );
}
