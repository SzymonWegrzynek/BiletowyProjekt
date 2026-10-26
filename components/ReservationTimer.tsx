"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { formatCountdown } from "@/lib/format";

type Props = {
  // ISO z serwera — liczymy od niego, nie od momentu kliknięcia.
  expiresAt: string;
  eventId: string;
  // Akcje dostępne tylko przed wygaśnięciem (np. „Kupuję bilet”).
  children?: ReactNode;
};

// Serwer ma ostatnie słowo: 410 przy zakupie kończy licznik, nawet gdy
// zegar przeglądarki pokazuje jeszcze kilka sekund.
const ExpireContext = createContext<(() => void) | null>(null);

export function useExpireReservation() {
  return useContext(ExpireContext);
}

// Ostatnia minuta — licznik zmienia kolor na cynober.
const URGENT_MS = 60_000;

export function ReservationTimer({ expiresAt, eventId, children }: Props) {
  const deadline = new Date(expiresAt).getTime();
  // null do pierwszego ticku po hydracji: czas serwera ≠ czas przeglądarki.
  const [now, setNow] = useState<number | null>(null);
  const [expiredByServer, setExpiredByServer] = useState(false);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);

  const remaining = now === null ? null : deadline - now;

  if (expiredByServer || (remaining !== null && remaining <= 0)) {
    return (
      <div role="alert" className="flex flex-col items-center text-center">
        <p className="title text-3xl leading-snug text-cinnabar">
          Rezerwacja wygasła, miejsce wróciło do puli
        </p>
        <Link
          href={`/spektakl/${encodeURIComponent(eventId)}`}
          className="btn-secondary mt-8"
        >
          Wróć do widowni
        </Link>
      </div>
    );
  }

  const urgent = remaining !== null && remaining <= URGENT_MS;

  return (
    <div className="flex flex-col items-center text-center">
      <p className="label">Trzymamy Twoje miejsce jeszcze</p>
      <p
        className={`title mt-3 text-7xl leading-none numerals transition-colors duration-500 sm:text-8xl ${
          urgent ? "text-cinnabar" : ""
        }`}
        aria-live="off"
      >
        {remaining === null ? "--:--" : formatCountdown(remaining)}
      </p>
      <div className="mt-10 flex w-full flex-col gap-3">
        <ExpireContext.Provider value={() => setExpiredByServer(true)}>
          {children}
        </ExpireContext.Provider>
      </div>
    </div>
  );
}
