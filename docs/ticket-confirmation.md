# Odczyt rezerwacji i mail z biletem — backend C

Karta: https://trello.com/c/KS2JwF4F

## Kontrakt odczytu

`GET /api/reservations/:id` zwraca `status`, `amount`, `expiresAt`,
`pointsUsed` oraz, po zakupie, `code`, `pointsEarned` i `cardAmount`.
Status bazy `purchased` jest mapowany na API `paid`; nieopłacona rezerwacja
po terminie ma status `expired`. Opłacona zachowuje `paid` po tym terminie.
Nie ma nagrody ani kodu w odpowiedzi dla `held`/`expired`.
Odczyt ma `Cache-Control: no-store`, brak lub błędne id → 404, awaria → 503.
Nie ujawnia e-maila, imienia ani informacji technicznych o wysyłce.

Przykład opłaconej rezerwacji:

```json
{
  "status": "paid",
  "amount": 6000,
  "expiresAt": "2026-11-20T12:15:00.000Z",
  "code": "TEA-TEST01",
  "cardAmount": 5000,
  "pointsUsed": 1000,
  "pointsEarned": 500
}
```

`amount` i `cardAmount` są w groszach. Nazwa `cardAmount` oznacza utrwaloną
kwotę właściwej, potwierdzonej płatności kartą; backend B musi zapisać ją
razem z `pointsUsed`, a backend A utrwalić `pointsEarned` po naliczeniu.
Czytamy wartości; nie wyliczamy nagrody, nie odpytujemy Voucherify.
W starszych dokumentach brak `amount` daje `null`, brak `pointsUsed` daje 0,
a brak `pointsEarned`/`cardAmount` oznacza pominięcie tych pól. Nie zastępujemy
ich dzisiejszą ceną ani wymyśloną nagrodą. Takie dokumenty nie spełniają
warunków wysłania pełnego rozliczenia.

## Podsumowanie na bilecie — frontend C

Strona `/bilet/[code]` odczytuje `amount`, `cardAmount`, `pointsUsed`
i `pointsEarned` z rezerwacji. Funkcja `settlementRows` jest wspólna
dla strony i maila: te same etykiety, kwota w złotych oraz całkowite punkty.
Zakup bez punktów ma zapisane `pointsUsed: 0`; nagroda jest odczytywana
z backendu, nie obliczana ponownie. Aktualna cena spektaklu nie zmienia
historycznego rozliczenia.

Rozliczenie wymaga potwierdzonego zakupu, kodu i kompletnych, spójnych
wartości. Przy starszych lub niepełnych danych strona zachowuje bilet
i pokazuje informację o niedostępności pełnego rozliczenia. Nie pokazuje
częściowej nagrody jako zakończonego rozliczenia. Oczekiwanie na webhook
na stronie płatności zachowuje dotychczasowe działanie.

`tests/ticket-points.test.ts` porównuje wyrenderowane pola strony z HTML
i tekstem maila na tych samych zaślepkach: z punktami, bez punktów,
kwota z groszami, zerowe wartości i niepełne rozliczenie. Sprawdza również
odrzucenie niepotwierdzonych zakupów oraz zachowanie danych spektaklu i kodu.

## Wywołanie serwerowe

`sendTicketConfirmation(reservationId)` pobiera dane ponownie z bazy,
sprawdza zakup, kod, komplet rozliczenia i jego spójność
(`cardAmount + pointsUsed === amount`), a następnie buduje HTML oraz tekst.
Nie przyjmuje kwot, adresu ani statusu od UI. Moduły `lib/server/` używają
Node crypto i nie mogą być importowane przez komponenty klienckie.

Obecny endpoint Etapu I `/purchase` wywołuje moduł dopiero po udanym zapisie
zakupu (również przy ponowieniu już kupionej rezerwacji). Starsze rezerwacje
bez rozliczenia są pomijane. Nie dopisujemy im sztucznie punktów.
Webhook Stripe nie istnieje jeszcze w tej gałęzi. Jego integracja musi
wywołać `await sendTicketConfirmation(id)` **po weryfikacji płatności,
zatwierdzeniu transakcji i zapisaniu pełnego rozliczenia**. Gdy punkty
nalicza późniejsze zadanie A, wywołanie należy umieścić po jego zapisie.
Powrót klienta ze Stripe ani żądanie GET nie uruchamiają wysyłki.

## Resend i test

Ustaw lokalnie (sekrety poza repo):

```dotenv
RESEND_API_KEY="..."
RESEND_FROM="Kasa teatru <onboarding@resend.dev>"
RESEND_MODE="test"
```

Tryb testowy dopuszcza `delivered@resend.dev`, `bounced@resend.dev` i warianty
z `+etykieta`, bez przekierowywania wiadomości klientów.
Produkcja wymaga `RESEND_MODE=live` oraz nadawcy z uprawnionej domeny.
W testach Vitest tryb live jest zablokowany. Nie ma nowych zależności:
adapter wykonuje serwerowy POST do Resend przez `fetch`, z timeoutem 8 s.

- `pnpm email:preview` — generuje lokalne HTML i tekst, nic nie wysyła.
- `pnpm email:test` — wysyła wyłącznie fikcyjny opłacony bilet z fixture
  do `delivered+bilet@resend.dev`. Wymaga klucza i nadawcy; wypisuje id przyjęcia.
  Potwierdzenie przyjęcia przez API nie oznacza jeszcze dostarczenia.
  Dostarczenie można sprawdzić w panelu Resend.
- `tests/ticket-email.test.ts` porównuje treść z publicznym odczytem
  rezerwacji i sprawdza zamockowane wywołanie Resend; nie wysyła maili.

Podgląd trafia do `artifacts/ticket-email-preview.html` i `.txt`.
Fixture to 60 zł ceny, 50 zł kartą, 1000 użytych punktów i 500 zdobytych.
Nie zapisuje danych do wspólnej bazy.

## Powtórzenia i awarie

Atomowy lease `confirmationEmail` wybiera jednego nadawcę. Stan `accepted`
przechowuje id Resend i czas przyjęcia; doręczenie zapisujemy osobno.
Zapisane są klucz operacji, dokładne body wysyłki, licznik prób i terminy.
Powtórzony webhook nie ponawia operacji. Operator może wykonać kontrolowane
retry po timeout/5xx z tym samym kluczem i body; maksymalnie 5 prób,
w ciągu 23 godzin od pierwszej. Brak konfiguracji/rozliczenia daje `skipped`.
Żaden z tych stanów nie cofa zakupu ani punktów.

Diagnostyka doręczenia, scenariusze testowe i komendy operatora:
[odporność wysyłki maila](email-reliability.md).

Dokumentacja: [wysyłanie maila](https://resend.com/docs/api-reference/emails/send-email),
[odbiorcy testowi](https://resend.com/docs/dashboard/emails/send-test-emails),
[idempotencja](https://resend.com/docs/dashboard/emails/idempotency-keys).
