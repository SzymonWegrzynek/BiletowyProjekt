# Etap IV — frontend kolejki i poczta oferty (Olek)

Stan 28.11.2026: implementacja niezależna od backendów A/B, na gałęzi
`feat/kolejka-frontend-resend`. Podstawą są karty i kontrakt z Trello / Project
Resources. Nie jest to jeszcze pełny przepływ kolejki na środowisku wspólnym.

## Co można sprawdzić teraz

```bash
pnpm dev
# http://localhost:3000/dev/kolejka
pnpm email:offer:preview
pnpm test
pnpm lint
pnpm build
```

Podgląd `/dev/kolejka` działa wyłącznie w trybie development. Ma dwa miejsca,
formularz zapisu, pozycję, potwierdzane wypisanie i przełączane scenariusze oferty,
wygaśnięcia, biletu, pominięcia i awarii. Transport działa w pamięci przeglądarki;
nie zapisuje do MongoDB, nie wysyła poczty i nie wykonuje płatności. Odnośniki
rezerwacji i biletu zawierają fikcyjne identyfikatory.

Podgląd maila powstaje w `artifacts/offer-email-preview.html` i `.txt`, bez bazy,
kluczy i wysyłki. Faktyczny frontend to `SeatMap`, `WaitlistForm`,
`WaitlistStatus` i `/kolejka/[id]`; używa ścieżek API z kontraktu.

## Granica integracji z A (Paweł)

| Operacja                        | Oczekiwany kontrakt frontendu                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/events/:id`           | `{ event, takenSeats, soldOut }`; `event.seats?: string[]`, np. `["A1", "A2"]`; bez `seats` dotychczasowe 80 miejsc                  |
| `POST /api/events/:id/waitlist` | `{ customerName, email }` → 200/201 `{ waitlistId, position }`                                                                       |
| `GET /api/waitlist/:id`         | `status`, `position`; dla `offered` także `reservationId`, `offerExpiresAt`; dla `done` `reservationId` potrzebne do pobrania biletu |
| `DELETE /api/waitlist/:id`      | 2xx (także 204); błąd nie jest pokazywany jako udane wypisanie                                                                       |

`waiting` wymaga dodatniej pozycji; pozostałe stany przyjmują nieujemną liczbę
lub `null`. Identyfikatory zapisu/rezerwacji to 24 znaki hex, czasy w API to ISO
UTC. `NOT_SOLD_OUT` przy zapisie wraca do wyboru miejsca, 404 zapisu pokazuje
„Nie ma takiego zapisu”. Imię/e-mail są walidowane przy polach przed wysyłką;
inne błędy serwera pokazuje formularz.

Podstawowy kontrakt GET kolejki nie zawiera `seatId`. Front przyjmuje je jako
opcjonalne rozszerzenie; jeśli go nie ma, kieruje po szczegóły miejsca do
rezerwacji. Aby pokazać numer miejsca już na stronie kolejki, backend musi
dodać to pole do odpowiedzi. Nie wolno brać miejsca z danych formularza.

Polling jest co 5 s po zakończeniu poprzedniego odczytu, z timeoutem 10 s.
Nie nakłada zapytań; ignoruje odpowiedź GET zakończoną po wypisaniu. Przy awarii
nie prezentuje starej pozycji jako aktualnej. Link do biletu pojawia się dopiero
po odczycie rezerwacji `paid` z kodem. Licznik oferty używa terminu serwera;
po zerze znika link do rozpoczęcia płatności. Backend nadal rozstrzyga ważność.

## Granica integracji z B (Szymon)

Typ `WaitlistOffer` w `lib/server/offer-mail.ts` opisuje dokument `waitlist`:
`_id: ObjectId`, `eventId: string`, `email`, `customerName`, `joinedAt: Date`,
`status`. Przy ofercie B zapisuje `reservationId: string`,
`offerExpiresAt: Date` oraz nowe `mail: { status: "pending" }`.

Rezerwacja musi istnieć, mieć ten sam event i e-mail, status `held`, a jej
`expiresAt` musi być równy `offerExpiresAt`. C czyta dane z MongoDB i zapisuje
wyłącznie `mail.*`; nie przydziela miejsc, nie nalicza punktów i nie zmienia
ważności oferty. B odpowiada za transakcje, indeksy oraz atomowe przejścia
`offered → done/missed/left`.

Po **zatwierdzeniu transakcji** nadania oferty B powinien wywołać
`sendOfferMail(waitlistId)` i odseparować ewentualny błąd od wyniku przydziału.
Wyzwalacze z karty „brak harmonogramu” powinny najpierw rozliczyć wygasłe oferty,
a potem wywołać `sendPendingOfferMails(eventId)`. Batch obsługuje najwyżej trzy
wiadomości kolejno, po maksymalnie 5 s wysyłki każda. Funkcje są gotowe, ale
wywołania z backendu B jeszcze nie istnieją.

### Handler webhooka

`createResendWebhookHandler({ markOfferMissed })` w
`lib/server/resend-webhook.ts` zwraca handler POST. **Nie jest jeszcze zamontowany
jako `/api/webhooks/resend`**: wymaga prawdziwej funkcji B. Po jej dostarczeniu
route handler ma eksportować wynik tej fabryki jako `POST`, w runtime Node.js.

Wymagania wobec `markOfferMissed(waitlistId)`:

- atomowo sprawdza, że aktualna oferta jest nieopłacona; współbieżna płatność
  i ponowiony bounce nie mogą odebrać biletu ani przydzielić miejsca dwa razy;
- przejście do `missed` i przydział następnej osobie są idempotentne; powtórne
  wywołanie także domyka pracę przerwaną awarią;
- rzuca błąd, jeśli operacja nie została trwale zakończona; wtedy webhook oddaje
  500, a Resend może ponowić. Po sukcesie C uruchamia batch poczty następnych ofert.

Handler weryfikuje surowe body, HMAC SHA-256 Svix, podpis w stałym czasie i czas
żądania z tolerancją 5 minut. Brak/niepoprawny podpis to 400, brak sekretu 503.
Zdarzenie `email.delivered` ustawia wyłącznie stan doręczenia; `email.bounced`
wywołuje B tylko dla aktualnej, niewygasłej i nieopłaconej oferty.
Nieznany `messageId` i inne typy zdarzeń dostają 200 bez zmian. Spóźniony bounce
nie unieważnia biletu. Testy przejścia kolejki używają idempotentnej zaślepki B;
nie potwierdzają jeszcze atomowości jego przyszłej implementacji.

## Wysyłka i ponowienia

`RESEND_API_KEY`, `RESEND_FROM`, `RESEND_MODE` i `APP_URL` są wspólne z etapem III.
Webhook dodatkowo wymaga `RESEND_WEBHOOK_SECRET` z panelu Resend. Bez trybu `live`
wysyłka dopuszcza tylko `delivered[+etykieta]@resend.dev` i
`bounced[+etykieta]@resend.dev`. Testy automatyczne zawsze mockują usługę.

Klucz `offer-<waitlistId>-<reservationId>` i dokładna treść żądania są utrwalane
przed pierwszym POST. Atomowy zapis przejmuje wysyłkę na 30 s. Po timeout lub
utracie zapisu odpowiedzi kolejna próba używa tego samego klucza i body.
Obowiązuje maksymalnie 5 prób, okno 23 h oraz wcześniejszy koniec ważności oferty.
Nie wolno ręcznie zerować stanu poczty, bo usunęłoby to ochronę przed duplikatem.

| Sytuacja                 | Zachowanie C                                                             | Wymagana integracja B               |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------- |
| Przyjęcie przez Resend   | `sent`, `messageId`, `acceptedAt`; nie oznacza doręczenia                | Brak zmiany oferty                  |
| Timeout / 5xx            | `failed`, `lastError`, ponowienie po 5/10/20/40 s                        | Wyzwalacze ponowień                 |
| 429                      | Uwzględnia `Retry-After`; samo sprawdzanie nie przesuwa cooldown         | Nie przedłużać oferty               |
| Stałe 4xx lub limit prób | `failed`, `retryable: false` albo wyczerpany limit; brak dalszej wysyłki | Wygasić ofertę po jej terminie      |
| Bounce                   | `bounced`; wywołanie B dla aktualnej nieopłaconej oferty                 | `markOfferMissed` i następna oferta |
| Brak webhooka            | `sent` pozostaje przyjęciem, nie deklaruje doręczenia                    | Oferta wygasa niezależnie od poczty |

Brak klucza/niepoprawny odbiorca testowy pomija wysyłkę. B nie może uzależniać
wygaszenia oferty od jakiegokolwiek stanu `mail`. Wczesny webhook przed utrwaleniem
`messageId` jest traktowany jako nieznany; mechanizm wygaśnięcia B pozostaje
konieczny także wtedy.

## Weryfikacja i pozostała praca

Testy: `waitlist-frontend.test.ts`, `offer-email.test.ts`,
`offer-mail-retry.test.ts`, `resend-offer-webhook.test.ts`. Obejmują treść i strefę
czasową maila, 10 równoległych prób, timeout po przyjęciu wiadomości, niezmienność
klucza/body, 429/5xx/4xx, podpis Svix, powtórzone i spóźnione zdarzenie oraz
ochronę opłaconego biletu. MongoDB w tych testach to izolowana baza testowa.

Do zamknięcia kart po integracji pozostało:

1. Backend A: endpointy, plan miejsc, `soldOut` i seed `waitlist-test`.
2. Backend B: atomowy przydział, wypisanie, wygaszanie i `markOfferMissed`;
   podłączenie C po transakcji i do wyzwalaczy ponowień.
3. Zamontowanie route webhooka i konfiguracja klucza oraz sekretu Resend.
4. Rzeczywiste testy `delivered+oferta@resend.dev` i
   `bounced+oferta@resend.dev`, potwierdzenie wyniku w Resend oraz pełny scenariusz
   następnej osoby i płatności z punktami. Dotychczas nie wysłano takiej wiadomości.

Specyfikacje dostawców:
[weryfikacja Svix](https://docs.svix.com/receiving/verifying-payloads/how-manual),
[weryfikacja Resend](https://resend.com/docs/webhooks/verify-webhooks-requests),
[typy zdarzeń](https://resend.com/docs/webhooks/event-types),
[idempotencja Resend — 24 h](https://resend.com/docs/dashboard/emails/idempotency-keys).
