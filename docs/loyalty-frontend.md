# Saldo i zdobyte punkty — karta A

Karta: https://trello.com/c/F7s289Od

Formularz rezerwacji pyta `GET /api/loyalty?email=…` dopiero po 400 ms
bez zmiany poprawnego e-maila. Oczekuje `{ email, points }` z całkowitym,
nieujemnym saldem. Adres jest przycinany i zamieniany na małe litery;
tę normalizację należy zachować w adapterze backendu A.

Zmiana adresu natychmiast usuwa poprzednie saldo ze strony (osobny stan
komponentu dla adresu), anuluje timer i zapytanie oraz unieważnia jego wynik.
To obejmuje także zmianę na błędny/pusty adres i powrót A → B → A.
Odpowiedź z innym e-mailem jest błędem. Timeout po 10 sekundach, błędy HTTP,
sieci i formatu pokazują komunikat oraz przycisk ponowienia. Nie blokują
rezerwowania. Nie ma cyklicznego odpytywania ani przechowywania salda w cache.

## Zaślepka i integracja

W `next dev` endpoint zwraca 1000 punktów dla każdego poprawnego e-maila.
To zaślepka nowego klienta, nie konto Voucherify; nie zapisuje bonusu ani
nie zmienia salda po zakupie. W produkcji zwraca 503 zamiast fikcyjnego salda.
Backend A zastępuje wnętrze handlera integracją Voucherify, zachowując
kształt odpowiedzi, walidację i `Cache-Control: no-store`.

Strona biletu odczytuje `pointsEarned` bezpośrednio z zapisanej rezerwacji,
tak jak pozostałe dane biletu. Po integracji frontendu C pokazuje ją razem
z `cardAmount` i `pointsUsed`, gdy zakup jest potwierdzony (`purchased`)
i pełne rozliczenie jest spójne. Nie liczy nagrody z ceny ani salda.
Brak wartości w starszym rekordzie oznacza niedostępność pełnego rozliczenia,
a zapisane 0 jest poprawną nagrodą. Strona i mail używają `settlementRows`.

## Sprawdzenie

1. Otwórz spektakl, wybierz wolne miejsce, wpisz e-mail: ładowanie → 1000.
2. Szybko zmień adres lub usuń go: stare saldo znika od razu.
3. Zablokuj `/api/loyalty` w narzędziach przeglądarki: czytelny błąd;
   odblokuj i kliknij „Sprawdź ponownie”.
4. Testy `loyalty.test.ts` sprawdzają spóźnione odpowiedzi, debounce,
   timeout i walidację. `ticket-points.test.ts` renderuje bilet z zaślepką
   rezerwacji z nagrodą 137 przy kwocie 6000, aby wykryć liczenie w UI.

Pełna ścieżka naliczania i zmian salda wymaga backendu A oraz płatności
Etapu II. Ta karta nie implementuje wydawania punktów ani naliczania nagrody.
