# CLAUDE.md

Instrukcje dla Claude Code w projekcie **Kasa biletowa teatru (PAS S01)**.

## Projekt

System rezerwacji biletów do teatru. Klient wybiera spektakl i miejsce, rezerwuje je na 15 minut, kupuje bilet i dostaje kod. **Etap I: bez płatności online.**

Projekt szkolny z przedmiotu Projektowanie i Architektura Systemów. Ocena opiera się na poprawności (reliability): transakcje, unikalne indeksy, warunkowe update'y, idempotencja.

## Stack

- **Next.js (App Router) + TypeScript** — front i API w jednym projekcie
- **MongoDB Atlas** + oficjalny sterownik **`mongodb`**
- **Tailwind CSS**, **Zod**, **Vitest**, **ESLint + Prettier**
- **pnpm**, hosting na **Vercel**

**Nie używaj:** Prismy, Mongoose, npm/yarn, Dockera, Redisa, bibliotek do stanu globalnego. Nie dodawaj nowych zależności bez pytania.

## Komendy

```bash
pnpm dev          # serwer deweloperski
pnpm build        # build produkcyjny
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm test         # Vitest (baza z MONGODB_DB_TEST, domyślnie teatr-test)
pnpm db:setup     # indeksy + seed — NIE uruchamiaj na wspólnej bazie bez pytania
```

Po zmianach zawsze uruchom `pnpm lint` i `pnpm test`.

## Struktura

```
app/                      # strony i route handlery
  api/events/route.ts
  api/events/[id]/route.ts
  api/reservations/route.ts
  api/reservations/[id]/purchase/route.ts
components/               # komponenty UI
lib/db.ts                 # połączenie z MongoDB (singleton)
lib/schemas.ts            # schematy Zod + typy (z.infer)
lib/errors.ts             # kody błędów i helper apiError()
lib/reservation.ts        # reguły ważności rezerwacji
lib/stubs.ts              # zaślepki danych, do usunięcia po podpięciu bazy
scripts/setup-db.ts       # indeksy + seed
tests/                    # testy API
```

## Kontrakt API — NIE ZMIENIAĆ

Kontrakt jest wspólny dla wszystkich zespołów, a testy nauczyciela sprawdzają go automatycznie. **Nie zmieniaj ścieżek, nazw pól ani kształtu odpowiedzi.**

| Endpoint                              | Body                                       | Odpowiedź                          |
| ------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `GET /api/events`                     | —                                          | lista spektakli                    |
| `GET /api/events/:id`                 | —                                          | `{ event, takenSeats }`            |
| `POST /api/reservations`              | `{ eventId, seatId, customerName, email }` | `201 { reservationId, expiresAt }` |
| `POST /api/reservations/:id/purchase` | —                                          | `201 { code }` albo odmowa         |

- `eventId`, `seatId`, `reservationId` to **stringi**
- `seatId`: rząd A–H + numer 1–10, np. `"F7"`
- `takenSeats`: miejsca kupione + miejsca z **ważną** rezerwacją (bez wygasłych)
- `expiresAt`: ISO string

### Błędy

Format: `{ "error": "komunikat po polsku", "code": "KOD" }`

| Status | `code`                | Kiedy                       |
| ------ | --------------------- | --------------------------- |
| 400    | `VALIDATION_ERROR`    | błędne dane (Zod)           |
| 404    | `NOT_FOUND`           | brak spektaklu / rezerwacji |
| 409    | `SEAT_TAKEN`          | miejsce zajęte              |
| 410    | `RESERVATION_EXPIRED` | rezerwacja wygasła          |
| 429    | `RATE_LIMITED`        | za dużo rezerwacji z 1 IP   |

Przy 429 dodajemy nagłówek `Retry-After` (sekundy).

Każdy błąd zwracaj przez `apiError()` z `lib/errors.ts`. Nigdy nie zwracaj 500 dla błędów, które da się przewidzieć.

## Zasady systemu (invarianty)

1. Jedno miejsce na spektaklu = najwyżej jedna aktywna rezerwacja albo bilet.
2. Bilet powstaje tylko z ważnej rezerwacji (`status: "held"` i `expiresAt > now`).
3. Jedna rezerwacja = jeden bilet (jeden kod).
4. Wygasła rezerwacja nie blokuje miejsca.
5. Czas ważności liczy serwer (`new Date()` po stronie API), nigdy klient.

**Invariantów pilnuje baza, nie `if`-y.** Nigdy nie pisz wzorca „najpierw `findOne`, potem `insertOne`/`updateOne`” dla operacji, które mogą się ścigać.

## Baza danych

### Kolekcje

```ts
type Event = {
  _id: string;
  title: string;
  date: string;
  time: string;
  stage: string;
};

type Reservation = {
  _id: ObjectId;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  status: "held" | "purchased";
  expiresAt: Date;
  code?: string;
  createdAt: Date;
};
```

### Indeksy

```ts
reservations.createIndex({ eventId: 1, seatId: 1 }, { unique: true });
reservations.createIndex(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $exists: true } } },
);
```

Definicje są w `ensureIndexes()` w `lib/db.ts` — wołają je `pnpm db:setup` i testy. Nie twórz indeksów w innym miejscu.

### Połączenie

Klient MongoDB tworzymy raz i trzymamy w `globalThis` (hot reload w dev nie może otwierać nowych połączeń). Zawsze importuj z `lib/db.ts`, nie twórz nowego `MongoClient` w route handlerach.

### Czas ważności

```ts
const TTL_MIN = Number(process.env.RESERVATION_TTL_MINUTES ?? 15);
```

Odczytuj tylko przez helper z `lib/reservation.ts`. Nie wpisuj na sztywno `15`.

## Wzorce, których używamy

### Miejsca zajęte (`takenSeats`)

```ts
const now = new Date();
reservations.find({
  eventId,
  $or: [{ status: "purchased" }, { status: "held", expiresAt: { $gt: now } }],
});
```

Ten filtr jest w `lib/reservation.ts` jako `activeReservationFilter(now)`. Używaj go wszędzie, nie pisz własnego.

### Rezerwacja (transakcja + unikalny indeks)

```ts
await session.withTransaction(async () => {
  await reservations.deleteOne(
    { eventId, seatId, status: "held", expiresAt: { $lte: now } },
    { session },
  );
  await reservations.insertOne(
    { ...data, status: "held", expiresAt },
    { session },
  );
});
// błąd E11000 (duplicate key) → ważna "held" z tym samym eventId, seatId,
// customerName i email? → 200 z tą rezerwacją (idempotentność) | inaczej 409
```

### Zakup (warunkowy atomowy update)

```ts
const updated = await reservations.findOneAndUpdate(
  { _id, status: "held", expiresAt: { $gt: now } },
  { $set: { status: "purchased", code } },
  { returnDocument: "after" },
);
if (!updated) {
  const existing = await reservations.findOne({ _id });
  // brak → 404 | purchased → 200 z tym samym kodem | wygasła → 410
}
```

Ponowny zakup tej samej rezerwacji **zwraca ten sam kod**, nie tworzy drugiego biletu.

### Limit rezerwacji (429)

`takeReservationSlot(ip, now)` z `lib/rate-limit.ts`: atomowy `$inc` z `upsert` w kolekcji `rateLimits`, klucz = IP + okno 10 s, limit z `RESERVATION_RATE_LIMIT` (domyślnie 30). Wołany po walidacji Zod, przed pierwszym zapytaniem o spektakl. Licznik jest w bazie, nie w pamięci — instancje na Vercelu nie dzielą RAM. Indeks TTL na `rateLimits.expiresAt` jest w `ensureIndexes()`.

### Walidacja

Każdy `POST` zaczyna się od `schema.safeParse(body)`. Schematy i typy są w `lib/schemas.ts`; typy wyprowadzamy przez `z.infer`, nie piszemy ich ręcznie drugi raz.

### Kod biletu

`crypto.randomBytes` / `crypto.randomUUID`, format czytelny dla człowieka, np. `TEA-7F3K9Q`. Bez dodatkowych paczek.

## Frontend

- Teksty w UI **po polsku**, kod i nazwy w **angielsku**.
- Strony: `/` repertuar, `/spektakl/[id]` widownia, `/rezerwacja/[id]` licznik + zakup, `/bilet/[code]` bilet.
- Widownia: scena na górze, rzędy A–H, fotele 1–10, zajęte wyszarzone i nieklikalne.
- Licznik liczony od `expiresAt` z serwera, nie od momentu kliknięcia.
- Przyciski wysyłające (`Rezerwuję`, `Kupuję bilet`) **zablokowane w trakcie** requestu.
- Nigdy nie pokazuj „Kupiono” bez kodu zwróconego przez serwer.
- Komunikaty: 409 → „Ktoś był szybszy — wybierz inne miejsce”, 410 → „Rezerwacja wygasła, miejsce wróciło do puli”.
- Tailwind, mobile-first. Bez dodatkowych bibliotek UI bez pytania.

### Przepływ danych między ekranami

```
/  ──klik spektaklu──▶  /spektakl/[eventId]  ──POST rezerwacji──▶  /rezerwacja/[reservationId]  ──POST zakupu──▶  /bilet/[code]
```

| Ekran              | Dostaje (z URL) | Skąd bierze resztę                                                 | Przekazuje dalej                                |
| ------------------ | --------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `/`                | —               | `GET /api/events`                                                  | `eventId` → `/spektakl/[eventId]`               |
| `/spektakl/[id]`   | `eventId`       | `GET /api/events/:id` → `{ event, takenSeats }`                    | `reservationId` → `/rezerwacja/[reservationId]` |
| `/rezerwacja/[id]` | `reservationId` | serwer czyta rezerwację z bazy: `expiresAt`, `seatId`, `event`     | `code` → `/bilet/[code]`                        |
| `/bilet/[code]`    | `code`          | serwer czyta bilet z bazy: spektakl, data, godzina, scena, miejsce | —                                               |

Zasady:

- **W URL tylko identyfikatory** (`eventId`, `reservationId`, `code`). Nigdy imienia ani e-maila w URL i nigdy `expiresAt` w query stringu.
- **Wybór miejsca nie zmienia adresu.** `seatId` żyje w stanie strony `/spektakl/[id]`, a formularz rezerwacji jest na tej samej stronie. Body `POST /api/reservations` to `{ eventId, seatId, customerName, email }`.
- **Po `201` z rezerwacji** → `router.push("/rezerwacja/" + reservationId)`. `expiresAt` z odpowiedzi nie przenosimy, bo ekran rezerwacji odczyta go sam z bazy. Licznik przetrwa wtedy odświeżenie strony.
- **`/rezerwacja/[id]` i `/bilet/[code]` to server components**, które czytają z bazy przez `lib/db.ts`. Kontrakt nie ma `GET` na pojedynczą rezerwację ani bilet, a nowych endpointów **nie dodajemy**. Do klienta trafiają tylko pola potrzebne na ekranie (bez e-maila). Brak rekordu → `notFound()`.
- **Po `201`/`200` z zakupu** → `router.push("/bilet/" + code)`. Bilet pokazujemy wyłącznie dla `status: "purchased"`.

Błędy po drodze:

| Gdzie              | Odpowiedź         | Co robi UI                                                                    |
| ------------------ | ----------------- | ----------------------------------------------------------------------------- |
| `/spektakl/[id]`   | 404               | „Nie ma takiego spektaklu” + link do `/`                                      |
| formularz          | 400               | komunikat przy polu, zostajemy w formularzu                                   |
| formularz          | 409               | komunikat 409, odświeżenie `takenSeats`, wybór innego miejsca                 |
| `/rezerwacja/[id]` | 410 / licznik = 0 | komunikat 410 + powrót do `/spektakl/[eventId]`; po zerze nie wysyłamy zakupu |
| `/rezerwacja/[id]` | 404               | „Nie ma takiej rezerwacji” + link do `/`                                      |

Do czasu podpięcia bazy front pracuje na zaślepkach z `lib/stubs.ts`: spektakle `dziady`, `wesele`, `kordian`; zajęte `A1`, `A2`, `C5`, `F7` (rezerwacja → 409); zakup zawsze zwraca `TEA-7F3K9Q`.

## Testy

- Vitest, testy w `tests/`, uruchamiane na bazie `teatr-test`.
- Każda zmiana w API = test.
- Obowiązkowe scenariusze: ścieżka główna, 409 przy zajętym miejscu, 400/404, 410 po wygaśnięciu, podwójny zakup = ten sam kod, podwójna identyczna rezerwacja = ta sama rezerwacja, 20 równoległych rezerwacji jednego miejsca od różnych klientów = dokładnie 1 sukces.
- Do testów wygaśnięcia ustaw krótki `RESERVATION_TTL_MINUTES` lub manipuluj `expiresAt` w bazie — nie czekaj w teście 2 minut.
- Limit: zalew rezerwacji z jednego IP = 429 z `Retry-After`, a inny IP rezerwuje normalnie. Testy wołają handlery bez IP, więc dzielą jeden licznik — `vitest.config.mts` podnosi `RESERVATION_RATE_LIMIT`. Test limitu ustawia niski limit przez `vi.stubEnv` i własne IP w `x-forwarded-for`.

## Git

- Gałąź `main` chroniona — pracuj na gałęzi `feat/...`, `fix/...`, `test/...`, `chore/...`, `docs/...`.
- Commity w stylu `feat: dodaj endpoint rezerwacji` (opis po polsku).
- Nie commituj `.env`, `package-lock.json`, `yarn.lock`.
- Nie rób `git push --force` na `main` i nie merguj PR-ów samodzielnie.

## Czego nie robić

- ❌ Zmieniać kontraktu API
- ❌ Sprawdzać i zapisywać w dwóch osobnych krokach (race condition)
- ❌ Liczyć ważności rezerwacji w przeglądarce
- ❌ Wpisywać sekretów do kodu — tylko `.env`
- ❌ Uruchamiać `pnpm db:setup` lub czyścić kolekcje na wspólnej bazie bez pytania
- ❌ Dodawać funkcji spoza Etapu I (płatności, kolejki) bez prośby
