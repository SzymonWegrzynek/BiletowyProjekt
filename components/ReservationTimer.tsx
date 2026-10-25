"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { formatCountdown } from "@/lib/format";

type Props = {
  // ISO z serwera — liczymy od niego, nie od momentu kliknięcia.
  expiresAt: string;
  eventId: string;
  // Akcje dostępne tylko przed wygaśnięciem (np. „Kupuję bilet”).
  children?: ReactNode;
};

export function ReservationTimer({ expiresAt, eventId, children }: Props) {
  const deadline = new Date(expiresAt).getTime();
  // null do pierwszego ticku po hydracji: czas serwera ≠ czas przeglądarki.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);

  if (now === null) {
    return <p className="text-lg">Trzymamy Twoje miejsce jeszcze --:--</p>;
  }

  const remaining = deadline - now;
  if (remaining <= 0) {
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="text-lg font-medium text-red-600">
          Rezerwacja wygasła, miejsce wróciło do puli
        </p>
        <Link href={`/spektakl/${eventId}`} className="underline">
          Wróć do widowni
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg">
        Trzymamy Twoje miejsce jeszcze{" "}
        <span className="font-mono font-semibold tabular-nums">
          {formatCountdown(remaining)}
        </span>
      </p>
      {children}
    </div>
  );
}
