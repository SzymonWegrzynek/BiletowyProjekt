import { formatPrice } from "@/lib/format";
import { getPointsPreview } from "@/lib/checkout-points";
import type { LoyaltyState } from "@/lib/loyalty";

export function CheckoutPoints({
  amount,
  value,
  balance,
  disabled,
  onChange,
  onRefresh,
}: {
  amount: number;
  value: string;
  balance: LoyaltyState;
  disabled: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
}) {
  const preview = getPointsPreview(amount, value, balance);
  return (
    <section
      aria-label="Płatność punktami"
      className="flex flex-col gap-3 rounded-lg border border-gray-200 p-4"
    >
      <div aria-live="polite">
        {balance.status === "ready" ? (
          <p>
            Saldo:{" "}
            <strong>{balance.points.toLocaleString("pl-PL")} punktów</strong>
          </p>
        ) : balance.status === "loading" ? (
          <p role="status">Sprawdzam saldo punktów…</p>
        ) : (
          <p role="alert">
            Nie udało się pobrać salda. Spróbuj ponownie lub zapłać bez punktów.
          </p>
        )}
      </div>
      <p id="checkout-points-help" className="text-sm text-gray-600">
        1 punkt = 1 grosz. Punktami pokryjesz najwyżej połowę ceny (
        {preview.limit.toLocaleString("pl-PL")} punktów).
        {balance.status === "ready" && (
          <>
            {" "}
            Teraz możesz użyć maksymalnie{" "}
            {preview.maximum.toLocaleString("pl-PL")} punktów.
          </>
        )}
      </p>
      <label htmlFor="checkout-points" className="text-sm font-medium">
        Użyj punktów
      </label>
      <input
        id="checkout-points"
        name="points"
        type="number"
        inputMode="numeric"
        min={0}
        max={preview.maximum}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || balance.status !== "ready"}
        aria-invalid={!preview.valid}
        aria-describedby={`checkout-points-help${preview.valid ? "" : " checkout-points-error"}`}
        className="rounded border border-gray-300 px-3 py-2 aria-invalid:border-red-600 disabled:opacity-50"
      />
      {!preview.valid && (
        <p
          id="checkout-points-error"
          role="alert"
          className="text-sm text-red-600"
        >
          {preview.error}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <button
          type="button"
          onClick={() => onChange("0")}
          disabled={disabled}
          className="underline disabled:opacity-50"
        >
          Bez punktów
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled || balance.status === "loading"}
          className="underline disabled:opacity-50"
        >
          Odśwież saldo
        </button>
      </div>
      <dl
        className="grid grid-cols-2 gap-2 border-t border-gray-200 pt-3"
        aria-live="polite"
      >
        <dt>Cena biletu</dt>
        <dd className="text-right">{formatPrice(amount)}</dd>
        <dt>Punkty</dt>
        <dd className="text-right">
          {preview.valid
            ? `${preview.points.toLocaleString("pl-PL")} (${formatPrice(preview.points)})`
            : "—"}
        </dd>
        <dt className="font-semibold">Dopłata kartą</dt>
        <dd className="text-right font-semibold">
          {preview.valid ? formatPrice(preview.cardAmount) : "—"}
        </dd>
      </dl>
    </section>
  );
}
