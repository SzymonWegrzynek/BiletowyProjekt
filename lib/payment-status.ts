export type PaymentStatus =
  | { status: "held" }
  | { status: "paid"; code: string }
  | { status: "expired" }
  | { status: "missing" }
  | { status: "error" };

// Kolejne zapytanie dopiero po zakończeniu poprzedniego: bez nakładania requestów.
export function watchPaymentStatus(
  reservationId: string,
  onStatus: (value: PaymentStatus) => void,
  options: {
    onDelayed?: () => void;
    onChecking?: (checking: boolean) => void;
  } = {},
) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let checking = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delayTimer = setTimeout(() => {
    if (!finished && !controller.signal.aborted) options.onDelayed?.();
  }, 30_000);

  async function poll() {
    if (checking || finished || controller.signal.aborted) return;
    clearTimeout(timer);
    checking = true;
    options.onChecking?.(true);
    const requestController = new AbortController();
    const requestTimeout = setTimeout(() => requestController.abort(), 10_000);
    let result: PaymentStatus;
    try {
      const response = await fetch(
        `/api/reservations/${encodeURIComponent(reservationId)}`,
        {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            requestController.signal,
          ]),
        },
      );
      if (response.status === 404) result = { status: "missing" };
      else if (response.status === 410) result = { status: "expired" };
      else {
        if (!response.ok) throw new Error("Status request failed");
        const data = await response.json();
        if (
          data.status === "paid" &&
          typeof data.code === "string" &&
          data.code.trim()
        ) {
          result = { status: "paid", code: data.code.trim() };
        } else if (data.status === "held" || data.status === "expired") {
          result = { status: data.status };
        } else throw new Error("Invalid payment status");
      }
    } catch {
      result = { status: "error" };
    } finally {
      clearTimeout(requestTimeout);
      checking = false;
    }
    if (controller.signal.aborted) return;
    options.onChecking?.(false);
    onStatus(result);
    if (result.status === "held" || result.status === "error") {
      timer = setTimeout(
        poll,
        Date.now() - startedAt >= 30_000 ? 10_000 : 2000,
      );
    } else {
      finished = true;
      clearTimeout(delayTimer);
    }
  }
  void poll();
  const stop = () => {
    controller.abort();
    clearTimeout(timer);
    clearTimeout(delayTimer);
  };
  return Object.assign(stop, {
    retry: () => {
      void poll();
    },
  });
}
