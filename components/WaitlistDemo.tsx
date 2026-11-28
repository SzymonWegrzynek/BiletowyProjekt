"use client";

import { useState } from "react";
import { SeatMap } from "./SeatMap";
import { WaitlistStatus } from "./WaitlistStatus";
import {
  STUB_WAITLIST_EVENT,
  STUB_WAITLIST_ID,
  STUB_WAITLIST_STATUS,
} from "@/lib/stubs";
import type { WaitlistApi } from "@/lib/waitlist-client";
import type { WaitlistStatus as Status } from "@/lib/waitlist";

function createDemoApi(
  scenario: keyof typeof STUB_WAITLIST_STATUS | "expired" | "error",
): WaitlistApi {
  let left = false;
  const expiresAt = new Date(
    Date.now() + (scenario === "expired" ? -1000 : 120_000),
  ).toISOString();
  return {
    async join() {
      return { waitlistId: STUB_WAITLIST_ID, position: 2 };
    },
    async read() {
      if (left) return { status: "left", position: 0 };
      if (scenario === "error") throw new Error("Awaria demonstracyjna");
      if (scenario === "offered" || scenario === "expired")
        return { ...STUB_WAITLIST_STATUS.offered, offerExpiresAt: expiresAt };
      return { ...STUB_WAITLIST_STATUS[scenario] } as Status;
    },
    async leave() {
      left = true;
    },
    async ticket() {
      return "TEA-DEMO";
    },
  };
}

export function WaitlistDemo() {
  const [scenario, setScenario] = useState<
    keyof typeof STUB_WAITLIST_STATUS | "expired" | "error"
  >("waiting");
  const [joined, setJoined] = useState(false);
  const [version, setVersion] = useState(0);
  const [api, setApi] = useState<WaitlistApi>(() => createDemoApi("waiting"));
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="alert mb-8">
        <strong>Podgląd lokalny — zaślepki</strong>
        <p>
          Nie zapisuje do bazy, nie rezerwuje miejsc, nie wysyła maili. Linki
          płatności i biletu pokazują docelowe ścieżki; dane demonstracyjne nie
          istnieją w bazie.
        </p>
      </div>
      <div className="mb-8 flex flex-wrap gap-2">
        <button
          className="btn-secondary"
          onClick={() => {
            setJoined(false);
            setApi(createDemoApi("waiting"));
          }}
        >
          Formularz zapisu
        </button>
        {(
          [
            "waiting",
            "offered",
            "expired",
            "done",
            "missed",
            "left",
            "error",
          ] as const
        ).map((name) => (
          <button
            className="btn-secondary"
            key={name}
            onClick={() => {
              setScenario(name);
              setApi(createDemoApi(name));
              setJoined(true);
              setVersion((v) => v + 1);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {joined ? (
        <WaitlistStatus
          key={`${scenario}-${version}`}
          id={STUB_WAITLIST_ID}
          api={api}
        />
      ) : (
        <SeatMap
          event={STUB_WAITLIST_EVENT}
          takenSeats={["A1", "A2"]}
          soldOut
          waitlistApi={api}
          onWaitlistJoined={() => {
            setJoined(true);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </main>
  );
}
