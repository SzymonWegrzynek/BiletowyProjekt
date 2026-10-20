## Spis treści

1. [Zakres Etapu I](#zakres-etapu-i)
2. [Zespół i odpowiedzialności](#zespół-i-odpowiedzialności)
3. [Stack technologiczny](#stack-technologiczny)
4. [Struktura monorepo](#struktura-monorepo)
5. [Uruchomienie lokalne](#uruchomienie-lokalne)
6. [Zmienne środowiskowe](#zmienne-środowiskowe)
7. [Kontrakt API](#kontrakt-api)
8. [Invarianty systemu](#invarianty-systemu)
9. [Koncepcje z lekcji PAS w projekcie](#koncepcje-z-lekcji-pas-w-projekcie)
10. [Praca z repozytorium](#praca-z-repozytorium)
11. [Zasady pracy w monorepo](#zasady-pracy-w-monorepo)
12. [Trello i Definition of Done](#trello-i-definition-of-done)
13. [Testy](#testy)

---

## Zakres Etapu I

Kasa biletowa **bez płatności online**. Jedna rezerwacja = jedno miejsce na jednym spektaklu.

1. Klient wybiera spektakl i wolne miejsce na planie widowni.
2. Rezerwuje je, podając imię i e-mail. Miejsce jest trzymane przez **15 minut** i dla innych wygląda na zajęte.
3. Klika **„Kupuję bilet”** i dostaje kod biletu.
4. Jeśli nie zdąży w 15 minut, rezerwacja przepada, a miejsce wraca do puli.

**Wariant teatr:**

| Pojęcie z kontraktu  | U nas                                     |
| -------------------- | ----------------------------------------- |
| Wydarzenie (`event`) | Spektakl (tytuł, data, godzina, scena)    |
| Miejsce (`seat`)     | Fotel na widowni, rzędy A–H, fotele 1–10  |
| `seatId`             | `"F7"`                                    |
| Dane przykładowe     | 3 spektakle na 2 scenach, widownia 8 × 10 |

**Ekrany:**

- **A. Repertuar i widownia:** lista spektakli i plan widowni (scena na górze, rzędy A–H, zajęte miejsca wyszarzone).
- **B. Rezerwacja miejsca:** formularz dla wybranego fotela („Rząd F, miejsce 7”) i licznik „Trzymamy Twoje miejsce jeszcze 14:32”.
- **C. Zakup biletu:** przycisk „Kupuję bilet”, potem ekran biletu (spektakl, data, scena, rząd, miejsce, kod). Po czasie komunikat: „Rezerwacja wygasła, miejsce wróciło do puli”.

---

## Zespół i odpowiedzialności

| Osoba      | Rola                      | Obszar                                                                                                         |
| ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Szymon** | Lider, backend            | Kontrakt wewnętrzny, baza danych, endpointy rezerwacji i zakupu, współbieżność, idempotencja, kolejka i worker |
| **Olek**   | UI/UX, frontend           | Makiety, repertuar, plan widowni, ekran biletu, UX odporności, dokumentacja architektury, dane przykładowe     |
| **Paweł**  | Frontend, lżejszy backend | Formularz z licznikiem, klient API, integracja ekranów, `GET /api/events`, walidacja, rate limiting, testy     |

Zadania są rozpisane na tablicy Trello (workspace **BiletowyProjekt**, tablica **Taski**). Zadania wymagane w Etapie I mają w nazwie prefiks `[Etap I]`.

---

## Stack technologiczny

| Warstwa        | Technologia                                           |
| -------------- | ----------------------------------------------------- |
| Frontend + API | **Next.js** (App Router) + **TypeScript**             |
| Style          | **Tailwind CSS**                                      |
| Baza danych    | **PostgreSQL**                                        |
| ORM / migracje | **Prisma**                                            |
| Walidacja      | **Zod**                                               |
| Praca w tle    | Własny **worker** (Node.js) + kolejka w tabeli `jobs` |
| E-mail (dev)   | **Mailpit** (testowy SMTP z podglądem w przeglądarce) |
| Monorepo       | **pnpm workspaces**                                   |
| Testy          | **Vitest**                                            |
| Środowisko     | **Docker Compose**                                    |

> Na slajdach z lekcji przykłady są w MongoDB. Wszystkie wzorce (transakcje, unikalne indeksy, warunkowe update'y, kolejka w tej samej bazie) przenoszą się 1:1 na PostgreSQL.

---

## Struktura monorepo

```
teatr/
├── apps/
│   ├── web/                    # Next.js: frontend + route handlery /api
│   │   ├── app/
│   │   │   ├── page.tsx                      # A: repertuar
│   │   │   ├── spektakl/[id]/page.tsx        # A: plan widowni
│   │   │   ├── rezerwacja/[id]/page.tsx      # B + C: licznik i zakup
│   │   │   ├── bilet/[code]/page.tsx         # C: bilet
│   │   │   └── api/
│   │   │       ├── events/route.ts                       # GET /api/events
│   │   │       ├── events/[id]/route.ts                  # GET /api/events/:id
│   │   │       ├── reservations/route.ts                 # POST /api/reservations
│   │   │       └── reservations/[id]/purchase/route.ts   # POST /api/reservations/:id/purchase
│   │   ├── components/         # komponenty UI
│   │   ├── lib/                # apiFetch (klient API), helpery frontu
│   │   └── middleware.ts       # rate limiting, load shedding
│   └── worker/                 # proces w tle: kolejka jobów (e-mail z biletem)
│       └── src/
│           ├── index.ts        # pętla: claim → praca → ack / retry / DLQ
│           └── tasks/          # handlery tasków, np. send-ticket-email.ts
├── packages/
│   ├── db/                     # Prisma: schema, migracje, klient, seed
│   │   ├── prisma/schema.prisma
│   │   ├── prisma/migrations/
│   │   └── src/seed.ts
│   └── shared/                 # wspólny kod front + back + worker
│       └── src/
│           ├── contract.ts     # typy z kontraktu API
│           ├── errors.ts       # kody błędów i statusy HTTP
│           ├── schemas.ts      # schematy Zod
│           └── reservation.ts  # isActive() i reguły ważności rezerwacji
├── tests/                      # testy kontraktu i testy odporności (E2E na API)
├── docs/
│   └── ARCHITEKTURA.md         # invarianty, decyzje, mapa koncepcji z lekcji
├── docker-compose.yml
├── .env.example
├── pnpm-workspace.yaml
└── README.md
```

**Zasada:** `apps/*` mogą importować z `packages/*`, ale nigdy odwrotnie. `apps/web` i `apps/worker` nie importują niczego od siebie nawzajem.

---

## Uruchomienie lokalne

### Wymagania

- Node.js (wersja LTS)
- pnpm
- Docker + Docker Compose

### Krok po kroku

```bash
# 1. Sklonuj repo i zainstaluj zależności
git clone <url-repo> teatr-kasa
cd teatr-kasa
pnpm install

# 2. Skopiuj zmienne środowiskowe
cp .env.example .env

# 3. Postaw bazę i Mailpit
docker compose up -d db mailpit

# 4. Migracje i dane przykładowe
pnpm db:migrate
pnpm db:seed

# 5. Odpal aplikację i worker (dwa terminale)
pnpm dev        # http://localhost:3000
pnpm worker
```

Podgląd wysłanych maili: http://localhost:8025 (Mailpit).

### Wszystko w Dockerze

```bash
docker compose up --build
```

### Tryb testów (rezerwacja ważna 2 minuty)

```bash
RESERVATION_TTL_MINUTES=2 pnpm dev
```

### Skrypty

| Skrypt                 | Co robi                                       |
| ---------------------- | --------------------------------------------- |
| `pnpm dev`             | Uruchamia `apps/web` w trybie deweloperskim   |
| `pnpm worker`          | Uruchamia worker kolejki                      |
| `pnpm build`           | Buduje wszystkie paczki                       |
| `pnpm lint`            | ESLint w całym repo                           |
| `pnpm typecheck`       | TypeScript bez emitowania plików              |
| `pnpm db:migrate`      | Migracje Prisma (dev)                         |
| `pnpm db:seed`         | Wgrywa dane przykładowe teatru                |
| `pnpm db:reset`        | Czyści bazę i wgrywa seed od nowa             |
| `pnpm test`            | Testy jednostkowe i testy kontraktu API       |
| `pnpm test:resilience` | Testy współbieżności, powtórek i przeciążenia |

---

## Zmienne środowiskowe

| Zmienna                           | Domyślnie                                       | Opis                                               |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                    | `postgresql://teatr:teatr@localhost:5432/teatr` | Połączenie z PostgreSQL                            |
| `RESERVATION_TTL_MINUTES`         | `15`                                            | Czas ważności rezerwacji; **w testach `2`**        |
| `RATE_LIMIT_ENABLED`              | `true`                                          | Wyłączenie rate limitu (np. pod testy nauczyciela) |
| `RATE_LIMIT_RESERVATIONS_PER_MIN` | `10`                                            | Limit rezerwacji na IP na minutę                   |
| `MAX_IN_FLIGHT`                   | `200`                                           | Próg load sheddingu (żądania w toku)               |
| `SMTP_HOST`                       | `localhost`                                     | Serwer SMTP (Mailpit w dev)                        |
| `SMTP_PORT`                       | `1025`                                          | Port SMTP                                          |
| `MAIL_FROM`                       | `kasa@teatr.local`                              | Nadawca maili z biletem                            |

**Nigdy nie commitujemy pliku `.env`.** Nowa zmienna = wpis w `.env.example` i w tej tabeli.

---

## Kontrakt API

Kontrakt jest **wspólny dla wszystkich zespołów**, bo testy nauczyciela uderzają w każdy projekt tak samo. **Nie zmieniamy nazw endpointów ani pól.**

| Endpoint                              | Body                                       | Odpowiedź                                                     |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `GET /api/events`                     | —                                          | lista spektakli                                               |
| `GET /api/events/:id`                 | —                                          | `{ event, takenSeats }`: miejsca kupione i z ważną rezerwacją |
| `POST /api/reservations`              | `{ eventId, seatId, customerName, email }` | `{ reservationId, expiresAt }`                                |
| `POST /api/reservations/:id/purchase` | —                                          | `{ code }` albo odmowa, gdy rezerwacja wygasła                |

`eventId` i `seatId` to zawsze tekst.

### Nasze rozszerzenia (zgodne wstecz)

- Opcjonalny nagłówek **`Idempotency-Key`** w POST-ach. Bez niego API działa normalnie.
- Format błędu: `{ "error": "opis po polsku", "code": "SEAT_TAKEN" }`

| Status | `code`                   | Kiedy                                      |
| ------ | ------------------------ | ------------------------------------------ |
| 400    | `VALIDATION_ERROR`       | Błędne dane wejściowe                      |
| 404    | `NOT_FOUND`              | Brak spektaklu / rezerwacji                |
| 409    | `SEAT_TAKEN`             | Miejsce kupione lub z ważną rezerwacją     |
| 410    | `RESERVATION_EXPIRED`    | Zakup po upływie czasu                     |
| 422    | `IDEMPOTENCY_KEY_REUSED` | Ten sam klucz użyty do innej operacji      |
| 429    | `RATE_LIMITED`           | Za dużo żądań od klienta (+ `Retry-After`) |
| 503    | `OVERLOADED`             | Serwer przeciążony (+ `Retry-After`)       |

---

## Invarianty systemu

Warunki, które muszą być prawdziwe dla **każdego** zatwierdzonego stanu bazy (E01):

1. Na jedno miejsce w jednym spektaklu przypada **najwyżej jedna** aktywna rezerwacja albo jeden bilet.
2. Bilet powstaje **tylko** z ważnej rezerwacji (`status = held` i `expiresAt > now()`).
3. Jedna rezerwacja = jedno miejsce = co najwyżej jeden bilet (jeden kod).
4. Wygasła rezerwacja **nigdy** nie blokuje miejsca.
5. Czas ważności liczy **serwer** (zegar bazy), nie klient.

Każda zmiana kodu, która dotyka rezerwacji lub zakupu, musi zachować te invarianty. Pilnuje ich **baza** (unikalne indeksy, warunki w `UPDATE`), a nie same `if`-y w kodzie.

---

## Koncepcje z lekcji PAS w projekcie

| Problem                            | Rozwiązanie                                            | Lekcja | Gdzie                            |
| ---------------------------------- | ------------------------------------------------------ | ------ | -------------------------------- |
| Dwóch klientów klika ten sam fotel | Unikalny indeks `(eventId, seatId)` + transakcja       | E01    | `api/reservations`               |
| Podwójny zakup jednej rezerwacji   | Warunkowy atomowy `UPDATE … WHERE status='held'`       | E01    | `api/reservations/[id]/purchase` |
| Retry po timeoucie, podwójny klik  | `Idempotency-Key`, blokada przycisku                   | E02    | API + `lib/apiFetch`             |
| Wiszący request                    | Timeout `AbortSignal.timeout()`                        | E04    | `lib/apiFetch`, worker           |
| Błąd zależności w UI               | Fallback, który nie kłamie; graceful degradation       | E04    | komponenty UI                    |
| Bot rezerwuje całą salę            | Rate limiting → 429 + `Retry-After`                    | E05    | `middleware.ts`                  |
| Szczyt ruchu na premierze          | Load shedding → 503                                    | E05    | `middleware.ts`                  |
| Mail z biletem spowalnia zakup     | Kolejka + worker, ack po pracy, retry z backoffem, DLQ | E06    | `apps/worker`                    |

Szczegóły i uzasadnienia: [`docs/ARCHITEKTURA.md`](docs/ARCHITEKTURA.md).

---

## Praca z repozytorium

### Gałęzie

- **`main`**: zawsze działająca wersja. **Chroniona**: zakaz bezpośredniego pusha, merge tylko przez Pull Request.
- **Gałęzie robocze**: jedna gałąź = jedna karta z Trello. Tworzymy je z aktualnego `main`.

**Nazewnictwo gałęzi:** `<typ>/<obszar>-<krótki-opis>`

| Typ         | Kiedy                            | Przykład                         |
| ----------- | -------------------------------- | -------------------------------- |
| `feat/`     | Nowa funkcja                     | `feat/b-backend-reservations`    |
| `fix/`      | Poprawka błędu                   | `fix/takenseats-expired`         |
| `test/`     | Testy                            | `test/resilience-race-condition` |
| `docs/`     | Dokumentacja                     | `docs/architektura`              |
| `chore/`    | Konfiguracja, zależności, CI     | `chore/docker-compose`           |
| `refactor/` | Zmiana kodu bez zmiany działania | `refactor/api-errors`            |

Gałęzie piszemy małymi literami, słowa oddzielamy myślnikami, bez polskich znaków.

### Commity (Conventional Commits)

```
<typ>(<zakres>): <opis w trybie rozkazującym>
```

Przykłady:

```
feat(api): dodaj POST /api/reservations z unikalnym indeksem
fix(web): blokuj przycisk zakupu w trakcie wysyłania
test(api): sprawdź 20 równoległych rezerwacji tego samego miejsca
chore(db): dodaj migrację tabeli jobs
docs(readme): opisz zmienne środowiskowe
```

Zakresy: `api`, `web`, `worker`, `db`, `shared`, `tests`, `docs`, `infra`.

### Przepływ pracy

```bash
# 1. Zaktualizuj main
git switch main
git pull

# 2. Utwórz gałąź dla karty z Trello
git switch -c feat/b-backend-reservations

# 3. Pracuj, commituj małymi krokami
git add .
git commit -m "feat(api): dodaj walidację body rezerwacji"

# 4. Przed PR zaciągnij świeży main
git fetch origin
git rebase origin/main

# 5. Wypchnij i otwórz Pull Request
git push -u origin feat/b-backend-reservations
```

### Pull Requesty

- **Tytuł** w formacie commita, np. `feat(api): POST /api/reservations`.
- **Opis:** link do karty Trello, co zmieniono, jak przetestować, zrzut ekranu (dla frontu).
- **Wymagany 1 review** od innej osoby z zespołu.
- **Zielone sprawdzenia:** `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- **Merge przez „Squash and merge”**: jeden PR = jeden czytelny commit na `main`.
- Po merge'u **usuwamy gałąź**.
- PR-y robimy **małe** (najlepiej do ~400 linii). Duża karta = kilka PR-ów.
- Konflikty rozwiązuje **autor PR-a**, przez rebase na `main`.

---

## Zasady pracy w monorepo

1. **Jedno `pnpm install` w korzeniu.** Nie instalujemy paczek w podfolderach przez npm/yarn. Zależność dodajemy do konkretnej paczki:

```bash
   pnpm --filter web add zod
   pnpm --filter @teatr/db add -D prisma
```

2. **Wspólny kod tylko w `packages/`.** Typy kontraktu, kody błędów, schematy Zod i reguły ważności rezerwacji są w `packages/shared`. Nie kopiujemy ich do `apps/`.
3. **Kontrakt i baza mają właściciela.** Zmiany w `packages/shared/src/contract.ts`, `packages/shared/src/errors.ts` i `packages/db/prisma/` wymagają review **Szymona** (plik `CODEOWNERS`).
4. **Migracje bazy:**
   - Nowa zmiana schematu = nowa migracja (`pnpm db:migrate --name opis-zmiany`).
   - **Nigdy nie edytujemy** migracji, która jest już na `main`.
   - Jedna migracja na PR. Przed merge'em sprawdzamy, czy nikt inny nie dodał migracji (rebase).
5. **Granice importów:** `packages/*` nie importują z `apps/*`. `apps/web` i `apps/worker` nie importują od siebie nawzajem; komunikują się wyłącznie przez bazę (tabela `jobs`).
6. **Najpierw zaślepki, potem integracja.** Front zaczyna od mocków z kontraktu wewnętrznego, więc nikt nie czeka na backend. Podmiana na prawdziwe API to osobny PR.
7. **Seed musi zawsze działać.** Kto zmienia schemat, aktualizuje też `packages/db/src/seed.ts`.
8. **Jedna konfiguracja narzędzi.** ESLint, Prettier i `tsconfig` bazowy są w korzeniu; paczki je rozszerzają, a nie nadpisują.

---

## Trello i Definition of Done

**Cykl karty:** `To Do` → `Doing` → `Review` (otwarty PR) → `Done` (zmergowane do `main`).

- Bierzesz kartę = przypisujesz się i przesuwasz ją do `Doing`.
- W PR podajesz link do karty, a w karcie link do PR-a.
- Blokuje Cię coś? Komentarz na karcie + oznaczenie osoby.

**Karta jest `Done`, gdy:**

- [ ] Kod jest zmergowany do `main` przez PR z review
- [ ] Lint, typecheck i testy przechodzą
- [ ] Kontrakt API i invarianty są zachowane
- [ ] Nowe zmienne środowiskowe są w `.env.example` i w README
- [ ] Zmiany w bazie mają migrację i działający seed
- [ ] Odhaczona checklista z opisu karty

---

## Testy

| Rodzaj        | Komenda                               | Co sprawdza                                                                            |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| Kontrakt API  | `pnpm test`                           | Ścieżka: lista → szczegóły → rezerwacja → zakup → kod; nazwy pól zgodne z kontraktem   |
| Wygasanie     | `RESERVATION_TTL_MINUTES=2 pnpm test` | Zakup po czasie → 410, miejsce znika z `takenSeats`                                    |
| Współbieżność | `pnpm test:resilience`                | 20 równoległych rezerwacji jednego miejsca → 1× sukces, 19× 409                        |
| Idempotencja  | `pnpm test:resilience`                | Retry z tym samym `Idempotency-Key` → ta sama rezerwacja; podwójny zakup → ten sam kod |
| Przeciążenie  | `pnpm test:resilience`                | Seria żądań z jednego IP → 429 z `Retry-After`                                         |
| Kolejka       | `pnpm test:resilience`                | Restart workera w trakcie → job wraca; błędny job → DLQ                                |
