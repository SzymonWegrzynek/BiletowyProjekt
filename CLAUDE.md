# CLAUDE.md

Instrukcje dla Claude Code w projekcie **Kasa biletowa teatru (PAS S01)**.

## Projekt

System rezerwacji biletów do teatru. Klient wybiera spektakl i miejsce, rezerwuje je na 15 minut, płaci przez **Stripe Checkout** (tryb testowy) i dostaje kod biletu.

- **Etap I** (zrobiony): rezerwacja, wygasanie, zakup bez płatności (`/purchase`), limit 429.
- **Etap II** (teraz): płatności Stripe — cena, sesja Checkout, webhook, status rezerwacji.

Projekt szkolny z przedmiotu Projektowanie i Architektura Systemów. Ocena opiera się na poprawności (reliability): transakcje, unikalne indeksy, warunkowe update'y, idempotencja.

## Stack

- **Next.js (App Router) + TypeScript** — front i API w jednym projekcie
- **MongoDB Atlas** + oficjalny sterownik **`mongodb`**
- **Tailwind CSS**, **Zod**, **Vitest**, **ESLint + Prettier**
- **pnpm**, hosting na **Vercel**

- **Stripe** — oficjalna paczka `stripe` (zgoda zespołu na Etap II), tylko po stronie serwera, przez `lib/stripe.ts`

**Nie używaj:** Prismy, Mongoose, npm/yarn, Dockera, Redisa, bibliotek do stanu globalnego, `@stripe/stripe-js` ani Stripe Elements (płacimy na stronie Stripe Checkout). Nie dodawaj innych nowych zależności bez pytania.

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
  api/reservations/[id]/route.ts            # Etap II: GET status
  api/reservations/[id]/purchase/route.ts
  api/reservations/[id]/checkout/route.ts   # Etap II: sesja Stripe
  api/webhooks/stripe/route.ts              # Etap II: webhook (Szymon)
components/               # komponenty UI
lib/db.ts                 # połączenie z MongoDB (singleton)
lib/schemas.ts            # schematy Zod + typy (z.infer)
lib/errors.ts             # kody błędów i helper apiError()
lib/reservation.ts        # reguły ważności rezerwacji
lib/stripe.ts             # klient Stripe (timeout), APP_URL, mapowanie awarii → 503
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

### Etap II — nowe endpointy i pola

Endpointy z tabeli wyżej zostają. Etap II tylko **dodaje** pola i endpointy:

| Endpoint                                 | Body                    | Odpowiedź                                       |
| ---------------------------------------- | ----------------------- | ----------------------------------------------- |
| `GET /api/events`, `GET /api/events/:id` | —                       | jak wyżej + `price` w każdym spektaklu          |
| `POST /api/reservations`                 | jak wyżej               | `201 { reservationId, expiresAt, amount }`      |
| `POST /api/reservations/:id/checkout`    | —                       | `200 { url }` — adres strony płatności Stripe'a |
| `GET /api/reservations/:id`              | —                       | `200 { status, amount, expiresAt, code? }`      |
| `POST /api/webhooks/stripe`              | surowe zdarzenie Stripe | `200`; zły podpis → `400`                       |

- `price` / `amount` — **grosze**, liczba całkowita (`6000` = 60 zł)
- `status` w `GET /api/reservations/:id`: `purchased` → `"paid"` (z `code`), `held` + `expiresAt > now` → `"held"`, `held` + `expiresAt <= now` → `"expired"`. Bez imienia i e-maila. Nagłówek `Cache-Control: no-store`.
- Adresy powrotu ze Stripe'a: `success_url` = `/rezerwacja/:id/platnosc`, `cancel_url` = `/rezerwacja/:id?anulowano=1`.
- Stary `POST /purchase` zostaje (testy Etapu I, decyzja nauczyciela w toku), ale **front używa tylko „Zapłać”**.

- `eventId`, `seatId`, `reservationId` to **stringi**
- `seatId`: rząd A–H + numer 1–10, np. `"F7"`
- `takenSeats`: miejsca kupione + miejsca z **ważną** rezerwacją (bez wygasłych)
- `expiresAt`: ISO string

### Błędy

Format: `{ "error": "komunikat po polsku", "code": "KOD" }`

| Status | `code`                | Kiedy                                              |
| ------ | --------------------- | -------------------------------------------------- |
| 400    | `VALIDATION_ERROR`    | błędne dane (Zod)                                  |
| 404    | `NOT_FOUND`           | brak spektaklu / rezerwacji                        |
| 409    | `SEAT_TAKEN`          | miejsce zajęte                                     |
| 410    | `RESERVATION_EXPIRED` | rezerwacja wygasła                                 |
| 409    | `ALREADY_PAID`        | `/checkout` dla opłaconej rezerwacji               |
| 429    | `RATE_LIMITED`        | za dużo rezerwacji z 1 IP                          |
| 503    | `PAYMENT_UNAVAILABLE` | Stripe nie odpowiada / brak konfiguracji płatności |

Przy 429 i 503 dodajemy nagłówek `Retry-After` (sekundy).

Każdy błąd zwracaj przez `apiError()` z `lib/errors.ts`. Nigdy nie zwracaj 500 dla błędów, które da się przewidzieć.

## Zasady systemu (invarianty)

1. Jedno miejsce na spektaklu = najwyżej jedna aktywna rezerwacja albo bilet.
2. Bilet powstaje tylko z ważnej rezerwacji (`status: "held"` i `expiresAt > now`). Wyjątek — webhook: opłacona sesja daje bilet, dopóki dokument `held` **istnieje**, także po `expiresAt` (unikalny indeks gwarantuje, że nikt inny nie ma tego miejsca). Dokumentu już nie ma albo ma `pointsReleasedAt` (punkty wydane na rezerwację wróciły do klienta) → zwrot.
3. Jedna rezerwacja = jeden bilet (jeden kod).
4. Wygasła rezerwacja nie blokuje miejsca.
5. Czas ważności liczy serwer (`new Date()` po stronie API), nigdy klient.
6. Rezerwacja jest opłacona **tylko** po webhooku Stripe'a z poprawnym podpisem. Powrót na `success_url` niczego nie dowodzi.
7. Kwota płatności pochodzi wyłącznie z `reservation.amount` w bazie — nigdy z requestu ani z aktualnej ceny spektaklu.
8. Klient, który zapłacił, dostaje **bilet albo zwrot** — nigdy nic. Webhook nie odpowiada 2xx, dopóki nie zapisze biletu albo nie zleci zwrotu.

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
  price: number; // grosze
};

type Reservation = {
  _id: ObjectId;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  status: "held" | "purchased";
  expiresAt: Date;
  amount?: number; // grosze, kopia event.price z chwili rezerwacji (brak w starych rezerwacjach Etapu I)
  checkoutSessionId?: string; // ostatnia sesja Stripe Checkout
  paidAt?: Date; // ustawia webhook
  paidSessionId?: string; // sesja, która opłaciła rezerwację (ustawia webhook)
  code?: string; // ustawia webhook (albo stary /purchase)
  createdAt: Date;
};
```

Status w bazie zostaje `held` / `purchased` — `paid` / `expired` istnieją tylko w odpowiedzi API.

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

### Płatność (Stripe Checkout)

- `/checkout`: odczyt rezerwacji → odmowa 404 / 409 `ALREADY_PAID` / 410 → `stripe.checkout.sessions.create` (`pln`, `unit_amount = amount`, `client_reference_id` i `metadata.reservationId` = id rezerwacji, `customer_email`, `expires_at` = minimum Stripe'a, 30 min) → warunkowy zapis `{ _id, status: "held" }` → `$set: { checkoutSessionId }` z `returnDocument: "before"`; poprzednia sesja jest wygaszana (`sessions.expire`).
- Webhook (`app/api/webhooks/stripe/route.ts`): surowe body `request.text()` → `constructWebhookEvent()` (zły / brak podpisu → 400, brak `STRIPE_WEBHOOK_SECRET` → 503). Inne zdarzenia i `payment_status !== "paid"` → 200 bez zmian. Opłacona sesja → jeden warunkowy zapis `{ _id, status: "held" }` (bez `expiresAt`) → `purchased` + `code` + `paidAt` + `paidSessionId`. Gdy zapis nie trafił:
  - `purchased` z tym samym `paidSessionId` → 200 bez zmian (ponowienie, ten sam kod)
  - `purchased` z inną sesją → zwrot (`duplicate_payment`)
  - brak dokumentu (miejsce przejęte po wygaśnięciu) albo sesja bez id rezerwacji → zwrot (`reservation_gone` / `unknown_reservation`) i zwrot punktów wydanych na tę rezerwację
  - `held` z `pointsReleasedAt` (wygasła, punkty już wróciły) → zwrot (`points_released`); filtr zapisu biletu ma `pointsReleasedAt: { $exists: false }`, więc wyścig „zwrot punktów” vs „spóźniona płatność” rozstrzyga baza
- Zwroty tylko przez `refundPayment()` z `lib/stripe.ts`: klucz idempotencji `refund-<sessionId>`, więc ponowiony webhook nie oddaje pieniędzy drugi raz. Błąd bazy albo zwrotu → 500, żeby Stripe ponowił.
- Klient Stripe tylko z `getStripe()` w `lib/stripe.ts` (timeout 8 s, 1 ponowienie). Awaria Stripe'a albo brak `STRIPE_SECRET_KEY` / `APP_URL` → **503 `PAYMENT_UNAVAILABLE`** + `Retry-After`, szczegóły tylko w logach. Rezerwacja zostaje `held`.
- `APP_URL` z env, nigdy z nagłówka `Host`.
- Klucze: tylko testowe (`sk_test_…`), tylko w `.env` / Vercelu, **bez** prefiksu `NEXT_PUBLIC_`.

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
- Komunikaty: 409 → „Ktoś był szybszy — wybierz inne miejsce”, 410 → „Rezerwacja wygasła, miejsce wróciło do puli”, 503 → „Płatności chwilowo niedostępne, spróbuj za chwilę”.
- Ceny pokazujemy w złotych (`6000` → „60 zł”), liczone z groszy.
- Bilet / „Opłacono” pokazujemy dopiero, gdy `GET /api/reservations/:id` zwróci `status: "paid"` z `code`.
- Tailwind, mobile-first. Bez dodatkowych bibliotek UI bez pytania.
- Wygląd: jeden ciemny motyw (grafit, ochra/złoto). Kolory to tokeny w `app/globals.css` (`bg-surface`, `text-gold`, `text-muted`…), a powtarzalne elementy to klasy `.card`, `.label`, `.title`, `.btn-primary`, `.btn-secondary`, `.field`, `.alert` — używaj ich zamiast surowych kolorów Tailwinda. Nagłówki: Cormorant Garamond (`.title`), reszta: Inter.

### Przepływ danych między ekranami

```
/  ──klik spektaklu──▶  /spektakl/[eventId]  ──POST rezerwacji──▶  /rezerwacja/[reservationId]
   ──„Zapłać” (POST /checkout)──▶  Stripe Checkout  ──success_url──▶  /rezerwacja/[id]/platnosc  ──status "paid"──▶  /bilet/[code]
                                                    ──cancel_url───▶  /rezerwacja/[id]?anulowano=1
```

| Ekran              | Dostaje (z URL) | Skąd bierze resztę                                                 | Przekazuje dalej                                |
| ------------------ | --------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `/`                | —               | `GET /api/events`                                                  | `eventId` → `/spektakl/[eventId]`               |
| `/spektakl/[id]`   | `eventId`       | `GET /api/events/:id` → `{ event, takenSeats }`                    | `reservationId` → `/rezerwacja/[reservationId]` |
| `/rezerwacja/[id]` | `reservationId` | serwer czyta rezerwację z bazy: `expiresAt`, `seatId`, `event`     | `code` → `/bilet/[code]`                        |
| `/bilet/[code]`    | `code`          | serwer czyta bilet z bazy: spektakl, data, godzina, scena, miejsce | —                                               |

Zasady:

- **W URL tylko identyfikatory** (`eventId`, `reservationId`, `code`) i flaga `anulowano=1` z `cancel_url`. Nigdy imienia ani e-maila w URL i nigdy `expiresAt` w query stringu.
- **Wybór miejsca nie zmienia adresu.** `seatId` żyje w stanie strony `/spektakl/[id]`, a formularz rezerwacji jest na tej samej stronie. Body `POST /api/reservations` to `{ eventId, seatId, customerName, email }`.
- **Po `201` z rezerwacji** → `router.push("/rezerwacja/" + reservationId)`. `expiresAt` z odpowiedzi nie przenosimy, bo ekran rezerwacji odczyta go sam z bazy. Licznik przetrwa wtedy odświeżenie strony.
- **`/rezerwacja/[id]` i `/bilet/[code]` to server components**, które czytają z bazy przez `lib/db.ts`. Strona `/rezerwacja/[id]/platnosc` odpytuje `GET /api/reservations/:id` co 2 s. Nowych endpointów poza tymi z Etapu II **nie dodajemy**. Do klienta trafiają tylko pola potrzebne na ekranie (bez e-maila). Brak rekordu → `notFound()`.
- **Po `201`/`200` z zakupu** → `router.push("/bilet/" + code)`. Bilet pokazujemy wyłącznie dla `status: "purchased"`.

Błędy po drodze:

| Gdzie              | Odpowiedź         | Co robi UI                                                                    |
| ------------------ | ----------------- | ----------------------------------------------------------------------------- |
| `/spektakl/[id]`   | 404               | „Nie ma takiego spektaklu” + link do `/`                                      |
| formularz          | 400               | komunikat przy polu, zostajemy w formularzu                                   |
| formularz          | 409               | komunikat 409, odświeżenie `takenSeats`, wybór innego miejsca                 |
| `/rezerwacja/[id]` | 410 / licznik = 0 | komunikat 410 + powrót do `/spektakl/[eventId]`; po zerze nie wysyłamy zakupu |
| `/rezerwacja/[id]` | 404               | „Nie ma takiej rezerwacji” + link do `/`                                      |

Do czasu podpięcia bazy front pracuje na zaślepkach z `lib/stubs.ts`: spektakle `dziady`, `wesele`, `kordian` (z `price`); zajęte `A1`, `A2`, `C5`, `F7` (rezerwacja → 409); zakup zawsze zwraca `TEA-7F3K9Q`. Etap II: `STUB_RESERVATION_RESPONSE` (z `amount`), `STUB_CHECKOUT_RESPONSE` (`{ url }`), `STUB_RESERVATION_STATUS` (`held` / `paid` / `expired`).

## Testy

- Vitest, testy w `tests/`, uruchamiane na bazie `teatr-test`.
- Każda zmiana w API = test.
- Obowiązkowe scenariusze: ścieżka główna, 409 przy zajętym miejscu, 400/404, 410 po wygaśnięciu, podwójny zakup = ten sam kod, podwójna identyczna rezerwacja = ta sama rezerwacja, 20 równoległych rezerwacji jednego miejsca od różnych klientów = dokładnie 1 sukces.
- Do testów wygaśnięcia ustaw krótki `RESERVATION_TTL_MINUTES` lub manipuluj `expiresAt` w bazie — nie czekaj w teście 2 minut.
- Etap II: Stripe w testach **zawsze mockowany** (`vi.mock("@/lib/stripe")`), bez prawdziwych zapytań. Podpisy webhooka przez `stripe.webhooks.generateTestHeaderString`. Obowiązkowo: `price` / `amount`, `/checkout` (200 / 404 / 409 / 410 / 503), kwota sesji = `amount`, `GET` dla `held` / `paid` / `expired` / 404, webhook: zły podpis 400, ten sam webhook 10× = jeden kod, płatność po wygaśnięciu = bilet albo zwrot, druga sesja = zwrot (`tests/webhook.test.ts`).
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
- ❌ Oznaczać rezerwację jako opłaconą gdziekolwiek poza webhookiem (i starym `/purchase`)
- ❌ Brać kwotę płatności z requestu albo z frontu
- ❌ Używać kluczy `sk_live_…` lub wystawiać klucz Stripe do przeglądarki
- ❌ Dodawać funkcji spoza Etapu II (kolejki, e-mail z biletem) bez prośby
