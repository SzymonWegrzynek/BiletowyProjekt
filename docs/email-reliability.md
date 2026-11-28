# Odporność poczty na timeout, błędy i odrzucenie

Płatność i punkty są zatwierdzone przed wywołaniem `sendTicketConfirmation`.
Ten moduł zapisuje wyłącznie `confirmationEmail`. Błąd lub timeout Resend
nie zmienia statusu zakupu, kodu biletu ani rozliczenia punktów. Strona biletu
działa i pokazuje informację o poczcie, również przy odrzuceniu wiadomości.

## Trwała operacja

`confirmationEmail` przechowuje `operationId`, dokładne `requestBody`
(z nadawcą i odbiorcą), `firstAttemptAt`, `attemptedAt`, `attempts`,
`attemptToken`, `leaseUntil`, `nextAttemptAt`, `lastError` oraz, po przyjęciu,
`providerId` i `acceptedAt`. Dane osobowe i treść z `requestBody` pozostają
wyłącznie na serwerze, nie są wypisywane przez komendę diagnostyczną.

| Stan wysyłki          | Znaczenie i działanie                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| brak                  | Nie rozpoczęto; wymaga konfiguracji, zakupu i pełnego rozliczenia               |
| `sending`             | Jedna próba ma lease 60 s; po jego wygaśnięciu można uzgodnić wynik przez retry |
| `accepted`            | Resend zwrócił id; NIE oznacza doręczenia, nie wysyłamy ponownie                |
| `retryable`           | Timeout, błąd sieci, 5xx, 429 albo niejednoznaczne 2xx; kontrolowane retry      |
| `blocked`             | Inne odrzucenie lub nieprawidłowa konfiguracja/body; diagnoza przed działaniem  |
| stare `sent`/`failed` | `sent` z id można sprawdzić; brak snapshotu/klucza wyklucza bezpieczne retry    |

Domyślne `sendTicketConfirmation(id)` wywołane ponownie przez webhook
nie wykonuje drugiej wysyłki. Jawne `sendTicketConfirmation(id, { retry: true })`
korzysta z oryginalnego requestu i klucza. Zmiana szablonu, nadawcy lub ceny
nie zmienia ponawianego body. Nie zmieniaj konta Resend w trakcie operacji:
idempotencja usługodawcy jest powiązana z kontem.

Przed próbą atomowe porównanie statusu, licznika i tokenu przejmuje lease.
Spóźniony wynik poprzedniej próby nie nadpisuje nowej. Nie ma automatycznej
pętli: odstępy po kolejnych niepowodzeniach to 30, 60, 120, 240, 480 sekund;
łącznie najwyżej 5 wysyłek. Resend zachowuje klucz 24 h, więc retry jest
ograniczone do 23 h od pierwszej próby. Po tym czasie lub po limicie prób
wynik `review-required` blokuje wysyłkę. Nie usuwaj stanu i nie generuj
nowego klucza: najpierw uzgodnij wynik w Resend. Tak samo postępuj z dawnymi
rekordami bez snapshotu oraz po błędzie 4xx wymagającym naprawy.

## Komendy operatora

Komendy uruchamia uprawniona obsługa z dostępem do serwera/bazy i Resend;
nie udostępniamy publicznego endpointu pozwalającego dowolnie wysyłać maile.

```sh
pnpm email:manage status <reservationId>
pnpm email:manage retry <reservationId>
pnpm email:manage check <reservationId>
```

`status` pokazuje stan, id operacji i Resend, liczbę prób, ostatni błąd,
termin oraz decyzję retry (`allowed`, `wait`, `review`, `not-needed`).
`retry` ponawia tylko pocztę; przy braku wcześniejszej operacji inicjuje ją.
`check` odpytuje autoryzowane `GET /emails/:id` w Resend i utrwala `last_event`.
Klucz Resend musi mieć uprawnienie odczytu wiadomości, a nie tylko wysyłki.
Awaria odczytu nie zmienia poprzedniego potwierdzonego stanu.

Osobne `deliveryStatus` rozróżnia `unknown`, `delivered`, `delayed`, `bounced`,
`failed`, `complained`, `suppressed`. `sent` z Resend nie jest `delivered`.
`delivered` oznacza doręczenie do serwera pocztowego, nie przeczytanie wiadomości.
Odczyt starszego stanu nie cofa doręczenia ani odrzucenia. Odśwież stronę
biletu po `check`, aby zobaczyć nowy komunikat.

Po `bounced` sprawdź w panelu Resend id wiadomości, zdarzenie, kod SMTP,
przyczynę oraz poprawność adresu. Nie wysyłaj automatycznie ponownie na
odrzucony adres. Test `bounced+...` symuluje SMTP 550 5.1.1. Po poprawieniu
adresu potrzebna jest osobna, świadomie zatwierdzona operacja obsługi,
nie odblokowanie starego klucza. Bilet na stronie pozostaje ważny.

## Testy i integracja z Szymonem

Mocks obejmują timeout po przyjęciu, 5xx, powtórzony webhook, równoległe retry,
utracony zapis po 2xx, granicę czasu, limit prób, odrzucenie, awarię odczytu
i niezmienność punktów. Testy strony sprawdzają dostępność biletu mimo awarii.

Po dodaniu lokalnego klucza i nadawcy wykonaj w trybie testowym:

```sh
pnpm email:test --scenario delivered --label odbior --operation proba1
pnpm email:test --scenario bounced --label odmowa --operation proba1
pnpm email:inspect <id-zwrócone-przez-Resend>
```

Oba wywołania używają fikcyjnej opłaconej rezerwacji, bez zapisu do bazy.
Powtórzenie tej samej pary scenariusz/etykieta/operacja w oknie 24 h używa
tego samego klucza. Do testów nowej treści stosuj nową etykietę operacji.
`email:inspect` tylko odczytuje stan maila testowego. Faktyczny test dostarczenia
wymaga Resend; mocki nie są dowodem dostarczenia w usłudze.

Webhook Stripe na `main` wywołuje zwykłe `sendTicketConfirmation(id)` po zapisie
biletu i próbie naliczenia nagrody. Powtórzone zdarzenie przechodzi przez
deduplikację. Nagroda oczekująca na Voucherify pozostaje osobną operacją.
Nie wolno wywoływać procesu naliczania punktów podczas `retry` maila.
W tej wersji status doręczenia odczytuje komenda `check`; integracja webhooka
Resend/pollera może później uruchamiać ten sam odczyt po providerId.

Źródła: [idempotencja Resend](https://resend.com/docs/dashboard/emails/idempotency-keys),
[odczyt wiadomości](https://resend.com/docs/api-reference/emails/retrieve-email),
[odbiorcy testowi](https://resend.com/docs/dashboard/emails/send-test-emails),
[znaczenie zdarzeń](https://resend.com/docs/webhooks/event-types).
