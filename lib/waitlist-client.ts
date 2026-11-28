import {
  joinedWaitlistSchema,
  waitlistStatusSchema,
  type JoinWaitlistInput,
  type WaitlistStatus,
} from "./waitlist";

export class WaitlistRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface WaitlistApi {
  join(
    eventId: string,
    input: JoinWaitlistInput,
  ): Promise<{ waitlistId: string; position: number }>;
  read(id: string, signal: AbortSignal): Promise<WaitlistStatus>;
  leave(id: string): Promise<void>;
  ticket(id: string, signal: AbortSignal): Promise<string | null>;
}
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new WaitlistRequestError(
      response.status,
      typeof body?.code === "string" ? body.code : "UNAVAILABLE",
      typeof body?.error === "string"
        ? body.error
        : "Nie udało się odczytać kolejki. Spróbuj ponownie.",
    );
  return body;
}
export const waitlistApi: WaitlistApi = {
  async join(eventId, input) {
    return joinedWaitlistSchema.parse(
      await request(`/api/events/${encodeURIComponent(eventId)}/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async read(id, signal) {
    return waitlistStatusSchema.parse(
      await request(`/api/waitlist/${encodeURIComponent(id)}`, { signal }),
    );
  },
  async leave(id) {
    await request(`/api/waitlist/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  async ticket(id, signal) {
    const body = await request(`/api/reservations/${encodeURIComponent(id)}`, {
      signal,
    });
    return body?.status === "paid" &&
      typeof body.code === "string" &&
      body.code.trim()
      ? body.code.trim()
      : null;
  },
};
export type WaitlistViewState =
  | { status: "loading" | "error" | "missing" }
  | WaitlistStatus
  | { status: "ticket"; code: string };

// Jedno żądanie naraz; anulowanie zabezpiecza także przed późnym GET po DELETE.
export function watchWaitlist(
  id: string,
  update: (value: WaitlistViewState) => void,
  api: WaitlistApi = waitlistApi,
) {
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  async function poll() {
    if (stopped || busy) return;
    clearTimeout(timer);
    busy = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 10_000);
    let terminal = false;
    try {
      const state = await api.read(id, controller.signal);
      if (stopped) return;
      if (state.status === "done" && state.reservationId) {
        // Brak odczytu biletu nie oznacza, że wpis w kolejce zniknął.
        const code = await api
          .ticket(state.reservationId, controller.signal)
          .catch(() => null);
        if (stopped) return;
        update(code ? { status: "ticket", code } : state);
        terminal = Boolean(code);
      } else {
        update(state);
        terminal = state.status === "left" || state.status === "missed";
      }
    } catch (error) {
      if (stopped) return;
      terminal = error instanceof WaitlistRequestError && error.status === 404;
      update({ status: terminal ? "missing" : "error" });
    } finally {
      clearTimeout(timeout);
      busy = false;
      if (!stopped && !terminal) timer = setTimeout(poll, 5000);
      if (terminal) stopped = true;
    }
  }
  void poll();
  return {
    stop() {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
    },
    refresh() {
      void poll();
    },
  };
}
