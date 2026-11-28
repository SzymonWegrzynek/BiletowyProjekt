"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { joinWaitlistSchema } from "@/lib/waitlist";
import {
  waitlistApi,
  WaitlistRequestError,
  type WaitlistApi,
} from "@/lib/waitlist-client";
import { Spinner } from "./Spinner";

export function WaitlistForm({
  eventId,
  onAvailable,
  api = waitlistApi,
  onJoined,
}: {
  eventId: string;
  onAvailable: () => void;
  api?: WaitlistApi;
  onJoined?: (id: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const [fields, setFields] = useState<
    Partial<Record<"customerName" | "email", string>>
  >({});
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current) return;
    const parsed = joinWaitlistSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget)),
    );
    setError(null);
    setFields({});
    if (!parsed.success) {
      const errors: typeof fields = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "customerName" || key === "email")
          errors[key] ??= issue.message;
      }
      setFields(errors);
      return;
    }
    locked.current = true;
    setSubmitting(true);
    try {
      const result = await api.join(eventId, parsed.data);
      if (onJoined) onJoined(result.waitlistId);
      else router.push(`/kolejka/${encodeURIComponent(result.waitlistId)}`);
      return;
    } catch (cause) {
      if (
        cause instanceof WaitlistRequestError &&
        cause.code === "NOT_SOLD_OUT"
      ) {
        onAvailable();
      } else if (
        cause instanceof WaitlistRequestError &&
        cause.status === 404
      ) {
        setError("Nie ma takiego spektaklu.");
      } else {
        setError(
          cause instanceof WaitlistRequestError
            ? cause.message
            : "Nie udało się zapisać. Spróbuj ponownie.",
        );
      }
    }
    locked.current = false;
    setSubmitting(false);
  }
  return (
    <section className="card p-7">
      <h2 className="title text-2xl">Wszystkie miejsca zajęte</h2>
      <p className="mt-3 text-sm text-muted">
        Dołącz do listy oczekujących. Zapis nie gwarantuje miejsca — jeśli
        dostaniesz ofertę, poinformujemy Cię mailowo.
      </p>
      {!open ? (
        <button
          type="button"
          className="btn-primary mt-6 w-full"
          onClick={() => setOpen(true)}
        >
          Powiadom mnie
        </button>
      ) : (
        <form onSubmit={submit} noValidate className="mt-6 flex flex-col gap-4">
          {(["customerName", "email"] as const).map((field) => (
            <div key={field}>
              <label
                className="text-sm font-medium"
                htmlFor={`waitlist-${field}`}
              >
                {field === "email" ? "E-mail" : "Imię"}
              </label>
              <input
                className="field mt-2 w-full"
                id={`waitlist-${field}`}
                name={field}
                type={field === "email" ? "email" : "text"}
                autoComplete={field === "email" ? "email" : "given-name"}
                maxLength={field === "email" ? 254 : 100}
                disabled={submitting}
                aria-invalid={Boolean(fields[field])}
                aria-describedby={
                  fields[field] ? `waitlist-${field}-error` : undefined
                }
              />
              {fields[field] && (
                <p
                  id={`waitlist-${field}-error`}
                  className="mt-1 text-sm text-cinnabar"
                >
                  {fields[field]}
                </p>
              )}
            </div>
          ))}
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          <button className="btn-primary w-full" disabled={submitting}>
            {submitting && <Spinner />}
            {submitting ? "Zapisuję…" : "Zapisz mnie na listę"}
          </button>
        </form>
      )}
    </section>
  );
}
