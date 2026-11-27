import { rateLimitsCollection } from "@/lib/db";

// Okno stałe 10 s. Licznik trzymamy w bazie, a nie w pamięci: na Vercelu
// każda instancja funkcji ma własną pamięć, więc limit w RAM działałby losowo.
const WINDOW_MS = 10_000;

function readLimit(name: string, fallback: number): number {
  const limit = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`${name} musi być dodatnią liczbą całkowitą`);
  }
  return limit;
}

// Ile rezerwacji jeden klient (IP) może wysłać w oknie. Zwykły klient robi 1–2,
// test równoległych rezerwacji robi 20 — limit nie może ich blokować.
export function getReservationRateLimit(): number {
  return readLimit("RESERVATION_RATE_LIMIT", 30);
}

// Ile odczytów salda (GET /api/loyalty) jeden klient (IP) może wysłać w oknie.
// Każdy odczyt może pytać Voucherify, a Sandbox ma 100 wywołań na godzinę —
// jeden klient odpytujący saldo w pętli nie może go zużyć wszystkim innym.
// Front pyta o saldo po wpisaniu e-maila i po zakupie, więc 10 na 10 s
// zwykłemu klientowi wystarcza z zapasem.
export function getLoyaltyRateLimit(): number {
  return readLimit("LOYALTY_RATE_LIMIT", 10);
}

// Vercel ustawia x-real-ip i x-forwarded-for sam, klient ich nie podmieni.
export function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  return forwarded?.trim() || "unknown";
}

// Zwraca null, gdy request mieści się w limicie, albo liczbę sekund do końca
// okna (nagłówek Retry-After). Jeden atomowy $inc z upsertem — bez wyścigu
// „odczytaj licznik, potem zapisz”. Równoległy upsert na tym samym _id
// MongoDB ponawia sam, więc nie kończy się E11000.
async function takeSlot(
  scope: string,
  ip: string,
  limit: number,
  now: Date,
): Promise<number | null> {
  const windowStart = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  const windowEnd = windowStart + WINDOW_MS;

  const counter = await rateLimitsCollection().findOneAndUpdate(
    { _id: `${scope}:${ip}:${windowStart}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowEnd) } },
    { upsert: true, returnDocument: "after" },
  );

  if (counter && counter.count <= limit) return null;
  return Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000));
}

export function takeReservationSlot(
  ip: string,
  now: Date,
): Promise<number | null> {
  return takeSlot("reservations", ip, getReservationRateLimit(), now);
}

// Osobny licznik: zalew odczytów salda nie blokuje rezerwacji i odwrotnie.
export function takeLoyaltySlot(ip: string, now: Date): Promise<number | null> {
  return takeSlot("loyalty", ip, getLoyaltyRateLimit(), now);
}
