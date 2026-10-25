# 🎭 Kasa biletowa teatru

Projekt zespołowy z przedmiotu **Projektowanie i Architektura Systemów**.
Klient wybiera spektakl i miejsce, rezerwuje je na 15 minut, a potem kupuje bilet i dostaje kod.
Etap I działa bez płatności online.

## Zespół

| Osoba      | Zakres                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| **Szymon** | kontrakt wewnętrzny, setup, baza, rezerwacja i zakup (backend)                  |
| **Olek**   | dane przykładowe, repertuar, plan widowni, ekran biletu                         |
| **Paweł**  | lista spektakli (backend), walidacja, formularz z licznikiem, integracja, testy |

Zadania: Trello → workspace **BiletowyProjekt**, tablica **Taski**.

## Stack

| Co          | Czym                                                                |
| ----------- | ------------------------------------------------------------------- |
| Front + API | **Next.js** (App Router) + **TypeScript**                           |
| Baza danych | **MongoDB Atlas** (darmowy klaster) + oficjalny sterownik `mongodb` |
| Wygląd      | **Tailwind CSS**                                                    |
| Walidacja   | **Zod**                                                             |
| Testy       | **Vitest**                                                          |
| Jakość kodu | **ESLint + Prettier**                                               |
| Paczki      | **pnpm**                                                            |
| Hosting     | **Vercel**                                                          |

Wszystko jest w **jednym projekcie i jednym repo**. Front i backend (`app/api`) działają razem w Next.js.

## Struktura projektu

```
teatr-kasa/
├── app/
│   ├── page.tsx                  # repertuar
│   ├── spektakl/[id]/page.tsx    # plan widowni
│   ├── rezerwacja/[id]/page.tsx  # licznik + zakup
│   ├── bilet/[code]/page.tsx     # bilet
│   └── api/
│       ├── events/route.ts                       # GET /api/events
│       ├── events/[id]/route.ts                  # GET /api/events/:id
│       ├── reservations/route.ts                 # POST /api/reservations
│       └── reservations/[id]/purchase/route.ts   # POST /api/reservations/:id/purchase
├── components/                   # komponenty UI
├── lib/
│   ├── db.ts                     # połączenie z MongoDB
│   ├── schemas.ts                # schematy Zod + typy
│   ├── errors.ts                 # kody i format błędów
│   └── reservation.ts            # zasady ważności rezerwacji
├── scripts/
│   └── setup-db.ts               # indeksy + dane przykładowe
├── tests/                        # testy API (Vitest)
├── .env.example
└── pnpm-lock.yaml
```

## Pierwsze uruchomienie

### 1. pnpm (raz na komputer)

```bash
corepack enable
pnpm -v
```

> ⚠️ **Używamy tylko pnpm.** Nie uruchamiamy `npm install` ani `yarn`.
> Commitujemy `pnpm-lock.yaml`, nie commitujemy `package-lock.json`.

### 2. Projekt

```bash
git clone <url-repo>
cd teatr-kasa
pnpm install
cp .env.example .env      # wklej MONGODB_URI od Szymona
pnpm dev                  # http://localhost:3000
```

Baza jest **wspólna, w chmurze (Atlas)** — nie trzeba niczego instalować lokalnie.

### Komendy

| Komenda             | Co robi                                  |
| ------------------- | ---------------------------------------- |
| `pnpm dev`          | uruchamia aplikację                      |
| `pnpm build`        | buduje wersję produkcyjną                |
| `pnpm lint`         | sprawdza kod                             |
| `pnpm format`       | formatuje kod (Prettier)                 |
| `pnpm test`         | testy API                                |
| `pnpm db:setup`     | tworzy indeksy i wgrywa dane przykładowe |
| `pnpm add <paczka>` | dodaje zależność                         |

## Zmienne środowiskowe

| Zmienna                   | Opis                                              |
| ------------------------- | ------------------------------------------------- |
| `MONGODB_URI`             | adres klastra Atlas (z hasłem)                    |
| `MONGODB_DB`              | nazwa bazy, np. `teatr` (do testów: `teatr-test`) |
| `RESERVATION_TTL_MINUTES` | czas ważności rezerwacji (15, w testach 2)        |

- Pliku `.env` **nie commitujemy**. Adres bazy przekazujemy sobie prywatnie.
- Nowa zmienna = wpis w `.env.example`.
- Testy odpalamy na osobnej bazie (`MONGODB_DB=teatr-test`), żeby nie czyścić danych reszcie zespołu.
- `pnpm db:setup` na wspólnej bazie uruchamia tylko **Szymon**.

## Baza danych

| Kolekcja       | Pola                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `events`       | `_id`, `title`, `date`, `time`, `stage`                                                                   |
| `reservations` | `_id`, `eventId`, `seatId`, `customerName`, `email`, `status` (`held` / `purchased`), `expiresAt`, `code` |

**Indeksy** (tworzone przez `pnpm db:setup`):

- `reservations`: unikalny `{ eventId: 1, seatId: 1 }` — jedno miejsce, jedna rezerwacja
- `reservations`: unikalny `{ code: 1 }` (tylko dla kupionych)

## Kontrakt API

Wspólny dla wszystkich zespołów — **nie zmieniamy nazw endpointów ani pól**.

| Endpoint                              | Wysyłamy                                   | Dostajemy                      |
| ------------------------------------- | ------------------------------------------ | ------------------------------ |
| `GET /api/events`                     | —                                          | lista spektakli                |
| `GET /api/events/:id`                 | —                                          | `{ event, takenSeats }`        |
| `POST /api/reservations`              | `{ eventId, seatId, customerName, email }` | `{ reservationId, expiresAt }` |
| `POST /api/reservations/:id/purchase` | —                                          | `{ code }` albo odmowa         |

- `takenSeats` = miejsca kupione + miejsca z ważną rezerwacją
- `seatId` = rząd + numer, np. `"F7"` (rzędy A–H, miejsca 1–10)

**Błędy:** `{ "error": "opis", "code": "SEAT_TAKEN" }`

| Kod | Kiedy                       |
| --- | --------------------------- |
| 400 | błędne dane (walidacja Zod) |
| 404 | brak spektaklu / rezerwacji |
| 409 | miejsce zajęte              |
| 410 | rezerwacja wygasła          |

## Zasady systemu

1. Jedno miejsce = najwyżej jedna aktywna rezerwacja albo bilet.
2. Bilet powstaje tylko z ważnej rezerwacji.
3. Jedna rezerwacja = jeden bilet.
4. Wygasła rezerwacja nie blokuje miejsca.
5. Czas ważności liczy serwer, nie przeglądarka.

Pilnuje ich **baza**, a nie same `if`-y w kodzie:

| Zasada                        | Jak                                                                     |
| ----------------------------- | ----------------------------------------------------------------------- |
| Podwójna rezerwacja           | unikalny indeks + transakcja (usuń wygasłą → wstaw nową)                |
| Zakup tylko ważnej rezerwacji | `findOneAndUpdate({ _id, status: "held", expiresAt: { $gt: now } }, …)` |
| Podwójny zakup                | ponowienie zwraca ten sam kod                                           |
| Błędne dane                   | schematy Zod w każdym POST                                              |

**Dlaczego unikalny indeks wystarczy na podwójną rezerwację:** nie sprawdzamy w kodzie, czy miejsce jest wolne. Od razu próbujemy zapisać rezerwację, a MongoDB przy indeksie unikalnym `{ eventId, seatId }` przepuści tylko jeden dokument dla danego miejsca, nawet gdy 20 requestów przyjdzie w tej samej milisekundzie. Pozostałe dostają błąd duplikatu `E11000`, który zamieniamy na `409 SEAT_TAKEN`. Transakcja jest potrzebna tylko po to, żeby usunąć wygasłą rezerwację tego miejsca i wstawić nową jako jedną niepodzielną operację.

## Praca z repozytorium

### Gałęzie

- `main` — zawsze działająca wersja, **zmiany tylko przez Pull Request**
- jedna karta z Trello = jedna gałąź z aktualnego `main`

| Szymon                     | Olek                | Paweł                       |
| -------------------------- | ------------------- | --------------------------- |
| `feat/kontrakt-wewnetrzny` | `feat/seed`         | `feat/api-events`           |
| `chore/setup`              | `feat/repertuar`    | `feat/walidacja`            |
| `feat/wygasanie`           | `feat/plan-widowni` | `feat/formularz-rezerwacji` |
| `feat/api-rezerwacja`      | `feat/ekran-biletu` | `feat/integracja`           |
| `feat/podwojna-rezerwacja` |                     | `test/kontrakt-api`         |
| `feat/api-zakup`           |                     |                             |

Prefiksy: `feat/` nowa funkcja, `fix/` poprawka, `test/` testy, `docs/` dokumentacja, `chore/` konfiguracja.

### Commity

```
feat: dodaj endpoint rezerwacji
fix: blokuj przycisk zakupu w trakcie wysyłania
```

### Krok po kroku

```bash
git switch main && git pull
git switch -c feat/plan-widowni
# ...praca...
git add . && git commit -m "feat: plan widowni"
git pull origin main          # zaciągnij zmiany innych
pnpm install                  # jeśli zmienił się pnpm-lock.yaml
git push -u origin feat/plan-widowni
# otwórz Pull Request na GitHubie
```

### Pull Request

- w opisie link do karty Trello i krótko: co zmienione, jak sprawdzić
- **1 review** od innej osoby z zespołu
- `pnpm lint` i `pnpm test` muszą przechodzić
- Vercel automatycznie tworzy podgląd PR — sprawdź, czy działa
- merge przez **Squash and merge**, potem usuń gałąź
- zmiany w `lib/db.ts`, `lib/schemas.ts`, `scripts/` i kontrakcie API — review **Szymona**
- nowa paczka = zmieniony `pnpm-lock.yaml` w tym samym PR

## Hosting

- **Vercel** — połączony z repo; `main` = wersja produkcyjna, każdy PR = podgląd
- Zmienne środowiskowe ustawione w panelu Vercela
- **Atlas → Network Access:** dozwolone `0.0.0.0/0` (Vercel nie ma stałego IP)
- Przed oddaniem etapu: eksport danych z Atlasa (darmowy klaster nie ma kopii zapasowych)

## Trello

`To Do` → `Doing` → `Review` (otwarty PR) → `Done` (zmergowane)

Karta jest **Done**, gdy kod jest na `main`, testy przechodzą, a checklista w karcie jest odhaczona.
