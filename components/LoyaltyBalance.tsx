"use client";

import { useEffect, useState } from "react";
import {
  loadLoyaltyBalance,
  loyaltyEmailSchema,
  type LoyaltyState,
} from "@/lib/loyalty";

export function LoyaltyBalance({ email }: { email: string }) {
  const parsed = loyaltyEmailSchema.safeParse(email);
  return (
    <section
      aria-label="Punkty lojalnościowe"
      aria-live="polite"
      className="rounded-2xl border border-line bg-surface p-3 text-sm text-ink"
    >
      {parsed.success ? (
        // Nowy adres = nowy stan od pierwszego renderu, także przy A → B → A.
        <BalanceForEmail key={parsed.data} email={parsed.data} />
      ) : (
        <p>Wpisz poprawny e-mail, aby sprawdzić saldo punktów.</p>
      )}
    </section>
  );
}

function BalanceForEmail({ email }: { email: string }) {
  const [state, setState] = useState<LoyaltyState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => loadLoyaltyBalance(email, setState), [email, attempt]);

  if (state.status === "loading")
    return <p role="status">Sprawdzam saldo punktów…</p>;
  if (state.status === "ready")
    return (
      <p>
        Saldo punktów: <strong>{state.points.toLocaleString("pl-PL")}</strong>
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p role="alert">
        Nie udało się pobrać salda punktów. Spróbuj ponownie. Możesz kontynuować
        rezerwację.
      </p>
      <button
        type="button"
        className="self-start font-medium text-gold underline"
        onClick={() => {
          setState({ status: "loading" });
          setAttempt((value) => value + 1);
        }}
      >
        Sprawdź ponownie
      </button>
    </div>
  );
}
