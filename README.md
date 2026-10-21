## Stack

- **Next.js + TypeScript** — front i API w jednym projekcie
- **PostgreSQL + Prisma** — baza danych
- **Tailwind CSS** — wygląd
- **Zod** — walidacja danych
- **Docker Compose** — baza lokalnie

## Struktura projektu

```
teatr-kasa/
├── app/
│   ├── page.tsx                  # repertuar
│   ├── spektakl/[id]/page.tsx    # plan widowni
│   ├── rezerwacja/[id]/page.tsx  # licznik + zakup
│   ├── bilet/[code]/page.tsx     # bilet
│   └── api/                      # endpointy z kontraktu
├── components/                   # komponenty UI
├── lib/                          # klient Prisma, typy, funkcje pomocnicze
├── prisma/                       # schemat, migracje, seed
├── tests/                        # testy API
├── docker-compose.yml
└── .env.example
```

## Uruchomienie

```bash
git clone <url-repo>
cd teatr-kasa
npm install
cp .env.example .env
docker compose up -d        # baza danych
npx prisma migrate dev      # migracje
npm run db:seed             # dane przykładowe
npm run dev                 # http://localhost:3000
```

**Tryb testów** (rezerwacja ważna 2 minuty): ustaw `RESERVATION_TTL_MINUTES=2` w `.env`.

| Komenda           | Co robi                   |
| ----------------- | ------------------------- |
| `npm run dev`     | uruchamia aplikację       |
| `npm run build`   | buduje wersję produkcyjną |
| `npm run lint`    | sprawdza kod              |
| `npm run db:seed` | wgrywa dane przykładowe   |
| `npm run test`    | testy API                 |

## Zmienne środowiskowe

| Zmienna                   | Opis                                       |
| ------------------------- | ------------------------------------------ |
| `DATABASE_URL`            | adres bazy PostgreSQL                      |
| `RESERVATION_TTL_MINUTES` | czas ważności rezerwacji (15, w testach 2) |

Pliku `.env` **nie commitujemy**. Nowa zmienna = wpis w `.env.example`.

## Kontrakt API

Wspólny dla wszystkich zespołów — **nie zmieniamy nazw endpointów ani pól**.

| Endpoint                              | Wysyłamy                                   | Dostajemy                      |
| ------------------------------------- | ------------------------------------------ | ------------------------------ |
| `GET /api/events`                     | —                                          | lista spektakli                |
| `GET /api/events/:id`                 | —                                          | `{ event, takenSeats }`        |
| `POST /api/reservations`              | `{ eventId, seatId, customerName, email }` | `{ reservationId, expiresAt }` |
| `POST /api/reservations/:id/purchase` | —                                          | `{ code }` albo odmowa         |

- `takenSeats` = miejsca kupione + miejsca z ważną rezerwacją
- `seatId` = rząd + numer, np. `"F7"`

**Błędy:** `{ "error": "opis", "code": "SEAT_TAKEN" }`

| Kod | Kiedy                       |
| --- | --------------------------- |
| 400 | błędne dane                 |
| 404 | brak spektaklu / rezerwacji |
| 409 | miejsce zajęte              |
| 410 | rezerwacja wygasła          |

## Zasady systemu

1. Jedno miejsce = najwyżej jedna aktywna rezerwacja albo bilet.
2. Bilet powstaje tylko z ważnej rezerwacji.
3. Jedna rezerwacja = jeden bilet.
4. Wygasła rezerwacja nie blokuje miejsca.
5. Czas ważności liczy serwer, nie przeglądarka.

Pilnuje ich baza (unikalny indeks, warunek w `UPDATE`), a nie same `if`-y w kodzie.

## Praca z repozytorium

### Gałęzie

- `main` — zawsze działająca wersja, **zmiany tylko przez Pull Request**
- jedna karta z Trello = jedna gałąź z aktualnego `main`

Nazwy: `feat/...` (nowa funkcja), `fix/...` (poprawka), `test/...`, `docs/...`
Przykład: `feat/plan-widowni`, `fix/takenseats-wygasle`

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
git push -u origin feat/plan-widowni
# otwórz Pull Request na GitHubie
```

### Pull Request

- w opisie link do karty Trello i krótko: co zmienione, jak sprawdzić
- **1 review** od innej osoby z zespołu
- `npm run lint` i `npm run test` muszą przechodzić
- merge przez **Squash and merge**, potem usuń gałąź
- zmiany w `prisma/` i kontrakcie API — review **Szymona**
- nie edytujemy migracji, które są już na `main` — robimy nową

## Trello

`To Do` → `Doing` → `Review` (otwarty PR) → `Done` (zmergowane)

Karta jest **Done**, gdy kod jest na `main`, testy przechodzą, a checklista w karcie jest odhaczona.
