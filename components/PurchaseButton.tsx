"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

const EXPIRED_MESSAGE = "Rezerwacja wygasła, miejsce wróciło do puli";

export function PurchaseButton({
  reservationId,
  eventId,
}: {
  reservationId: string;
  eventId: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  async function purchase() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/reservations/${encodeURIComponent(reservationId)}/purchase`,
        { method: "POST" },
      );
      const body: unknown = await response.json().catch(() => null);

      if (
        (response.status === 200 || response.status === 201) &&
        typeof body === "object" &&
        body !== null &&
        "code" in body &&
        typeof body.code === "string" &&
        body.code.length > 0
      ) {
        router.push(`/bilet/${encodeURIComponent(body.code)}`);
        return;
      }

      if (response.status === 410) {
        setExpired(true);
      } else {
        setError("Nie udało się kupić biletu. Spróbuj ponownie.");
      }
      setSubmitting(false);
    } catch {
      setError("Nie udało się kupić biletu. Spróbuj ponownie.");
      setSubmitting(false);
    }
  }

  if (expired) {
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="text-lg font-medium text-red-600">{EXPIRED_MESSAGE}</p>
        <Link
          href={`/spektakl/${encodeURIComponent(eventId)}`}
          className="underline"
        >
          Wróć do widowni
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={purchase}
        disabled={submitting}
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Kupuję…" : "Kupuję bilet"}
      </button>
    </div>
  );
}
