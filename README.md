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
│   ├── reservation.ts            # zasady ważności rezerwacji
│   └── stubs.ts                  # zaślepki danych (do usunięcia po podpięciu bazy)
├── scripts/
│   └── setup-db.ts               # indeksy + dane przykładowe
├── tests/                        # testy API (Vitest)
├── .github/workflows/ci.yml      # CI: lint, formatowanie, testy, build
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

| Zmienna                   | Opis                                           |
| ------------------------- | ---------------------------------------------- |
| `MONGODB_URI`             | adres klastra Atlas (z hasłem)                 |
| `MONGODB_DB`              | wspólna baza aplikacji: `teatr`                |
| `MONGODB_DB_TEST`         | baza dla `pnpm test`: `teatr-test` (domyślnie) |
| `RESERVATION_TTL_MINUTES` | czas ważności rezerwacji w minutach (15)       |

- Pliku `.env` **nie commitujemy**. Adres bazy przekazujemy sobie prywatnie.
- Nowa zmienna = wpis w `.env.example`.
- `pnpm test` zawsze działa na bazie z `MONGODB_DB_TEST`, żeby nie czyścić danych reszcie zespołu. Jeśli wskazuje tę samą bazę co `MONGODB_DB`, testy w ogóle nie ruszą.
- Wygaśnięcie testujemy, przestawiając `expiresAt` w bazie, a nie czekając na upływ czasu.
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

- `main` — zawsze działająca wersja, **zmiany tylko przez Pull Request**. Nie commitujemy na nim bezpośrednio, GitHub i tak odrzuci push.
- jedna karta z Trello = jedna gałąź z aktualnego `main`
- gałąź żyje krótko: od wzięcia karty do merge, najlepiej 1–3 dni. Duża karta → kilka mniejszych PR-ów.

**Nazwa gałęzi:** `prefiks/krotki-opis`

| Prefiks  | Kiedy                                            | Przykład                     |
| -------- | ------------------------------------------------ | ---------------------------- |
| `feat/`  | nowa funkcja lub ekran                           | `feat/plan-widowni`          |
| `fix/`   | poprawka błędu                                   | `fix/licznik-po-odswiezeniu` |
| `test/`  | same testy                                       | `test/kontrakt-api`          |
| `docs/`  | tylko dokumentacja (`README.md`, `CLAUDE.md`)    | `docs/przeplyw-ekranow`      |
| `chore/` | konfiguracja, paczki, CI, porządki — bez funkcji | `chore/setup`                |

- małe litery, słowa oddzielone `-`, **bez polskich znaków** i spacji (`plan-widowni`, nie `Plan_Widowni` ani `plan-widowni-ąę`)
- 2–4 słowa, które mówią, co robi gałąź; bez imion i dat
- poprawka do już zmergowanej karty = **nowa gałąź** `fix/...`, nie wracamy do starej

| Szymon                     | Olek                | Paweł                       |
| -------------------------- | ------------------- | --------------------------- |
| `feat/kontrakt-wewnetrzny` | `feat/seed`         | `feat/api-events`           |
| `chore/setup`              | `feat/repertuar`    | `feat/walidacja`            |
| `feat/wygasanie`           | `feat/plan-widowni` | `feat/formularz-rezerwacji` |
| `feat/api-rezerwacja`      | `feat/ekran-biletu` | `feat/integracja`           |
| `feat/podwojna-rezerwacja` |                     | `test/kontrakt-api`         |
| `feat/api-zakup`           |                     |                             |

### Commity

```
feat: dodaj endpoint rezerwacji
fix: blokuj przycisk zakupu w trakcie wysyłania
```

- ten sam prefiks co gałąź, opis po polsku, w trybie rozkazującym („dodaj”, „popraw”, nie „dodałem”)
- commituj często, małymi krokami — przy Squash and merge i tak powstanie jeden commit na `main`

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

**Kiedy otworzyć:**

- gdy karta jest skończona → zwykły PR, karta w Trello na `Review`
- gdy chcesz wcześnie pokazać kierunek → **Draft PR** (strzałka przy „Create pull request” → „Create draft pull request”). Draftu nie da się zmergować; po skończeniu klikasz **Ready for review**.

**Tytuł i opis:**

- tytuł jak commit: `feat: plan widowni`
- w opisie: link do karty Trello, co zmienione, jak sprawdzić (np. „wejdź na `/spektakl/dziady`, kliknij F7 → 409”)
- po prawej **Reviewers** — wybierz osobę, żeby dostała powiadomienie

**Wymagania do merge** (pilnuje ich ruleset na `main`):

- **1 approve** od innej osoby z zespołu — swojego PR nie zatwierdzisz
- CI (`lint, format, test, build`) musi być zielone
- zmiany w `lib/db.ts`, `lib/schemas.ts`, `scripts/` i kontrakcie API — review **Szymona**
- nowa paczka = zmieniony `pnpm-lock.yaml` w tym samym PR
- Vercel automatycznie tworzy podgląd PR — sprawdź, czy działa

**Review:**

- recenzent: **Files changed** → komentarze przy liniach → **Review changes** → `Approve` albo `Request changes`
- autor poprawia **w tej samej gałęzi** (`git commit` + `git push`) — nowe commity same trafiają do PR, nowego PR nie otwieramy
- po poprawkach: odpowiedz na komentarze, kliknij **Resolve conversation** i ponownie poproś o review (ikona 🔄 przy recenzencie)
- review w ciągu doby — nie blokujemy innych

**Konflikty / „This branch is out-of-date”:**

```bash
git switch feat/plan-widowni
git pull origin main          # rozwiąż konflikty w edytorze, jeśli są
pnpm install                  # jeśli zmienił się pnpm-lock.yaml
git add . && git commit       # tylko gdy były konflikty
git push
```

Bez konfliktów wystarczy przycisk **Update branch** w PR.

**Merge:**

- robi go **autor PR** po approve i zielonym CI
- zawsze **Squash and merge** — na `main` ląduje jeden commit z tytułem PR
- karta w Trello → `Done`

**Kiedy zamknąć PR bez merge (Close pull request):** zmiana okazała się niepotrzebna, kierunek się zmienił albo PR zastępuje inny — wtedy w komentarzu napisz dlaczego i podlinkuj nowy PR.

### Usuwanie gałęzi

Gałąź usuwamy **zaraz po merge** — jest już w `main`, a stara gałąź tylko myli.

- na GitHubie: przycisk **Delete branch** pod zmergowanym PR
- lokalnie:

```bash
git switch main && git pull
git branch -d feat/plan-widowni   # -d odmówi, jeśli coś nie jest zmergowane
git fetch --prune                 # usuwa lokalne odnośniki do skasowanych gałęzi zdalnych
```

Po Squash and merge `git branch -d` może zgłosić, że gałąź „nie jest w pełni zmergowana” (bo na `main` jest nowy, spłaszczony commit). Jeśli PR na GitHubie ma status **Merged**, usuń ją przez `git branch -D`.

Nie usuwamy `main` i gałęzi z otwartym PR.

## Hosting

- **Vercel** — połączony z repo; `main` = wersja produkcyjna, każdy PR = podgląd
- Zmienne środowiskowe ustawione w panelu Vercela
- **Atlas → Network Access:** dozwolone `0.0.0.0/0` (Vercel nie ma stałego IP)
- Przed oddaniem etapu: eksport danych z Atlasa (darmowy klaster nie ma kopii zapasowych)

## Trello

`To Do` → `Doing` → `Review` (otwarty PR) → `Done` (zmergowane)

Karta jest **Done**, gdy kod jest na `main`, testy przechodzą, a checklista w karcie jest odhaczona.
