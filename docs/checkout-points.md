# Wybór punktów i dopłata — frontend B

Karta: https://trello.com/c/RovACQe9

Ekran rezerwacji przekazuje do `CheckoutButton` zapisaną kwotę `amount`
i e-mail rezerwacji. E-mail jest używany wyłącznie do pobierania salda
przez `GET /api/loyalty?email=…`; nie trafia do URL strony ani checkoutu.
Klucz komponentu obejmuje rezerwację i adres, aby ich zmiana resetowała stan.

Pole „Użyj punktów” zaczyna od 0. Maksimum to
`min(saldo, floor(amount / 2))`, kurs wynosi 1 punkt = 1 grosz.
Podsumowanie i przycisk liczą podgląd w całkowitych groszach:
6000 groszy − 1000 punktów = „Zapłać 50 zł”. Puste pole, liczby ujemne,
ułamki, zapis wykładniczy i wartości ponad limit blokują płatność.
Pola i przyciski są zablokowane podczas żądania oraz przekierowania.

Checkout otrzymuje wyłącznie `POST { points }` (również `{ points: 0 }`).
Kwota z UI nie jest wysyłana: backend B musi ponownie sprawdzić saldo,
limit oraz kwotę i utworzyć właściwą sesję płatności.
Wywołania `retryPayment` bez argumentu `points` zachowują stary POST bez body.

Saldo odświeża się po powrocie do okna, ręcznie i po odrzuceniu checkoutu
z punktami. Stary odczyt jest anulowany przed nowym. Podczas odświeżania
lub awarii można wybrać „Bez punktów” i zapłacić całą cenę. Spadek salda
nie zmienia samodzielnie wpisanej liczby ani nie zwiększa po cichu dopłaty:
wybór ponad nowe maksimum pozostaje błędny do poprawienia przez klienta.

Komunikaty 4xx z pola `error` są wyświetlane; pozostałe awarie mają komunikat
ogólny. 409 z kodem innym niż `ALREADY_PAID` jest odrzuceniem checkoutu,
a nie potwierdzeniem zakupu. `ALREADY_PAID` i starsze 409 bez kodu nadal
uruchamiają odczyt statusu; wygaśnięcie nadal kończy płatność. Po anulowaniu
najpierw sprawdzany jest status, a potem wysyłany bieżący wybór punktów.
Żaden błąd nie wywołuje automatycznie następnej płatności.

## Weryfikacja i zależności

- Lokalna zaślepka A zwraca 1000 punktów. Odczyt statusu jest już dostępny
  w karcie C. Backend checkout B nadal wymaga integracji; kontrakt checkoutu
  testujemy na mockach. Pełna płatność Stripe wymaga backendu B i webhooka.
- `checkout-points.test.ts`: limity, grosze, błędne wartości, zmiana salda,
  zakup bez punktów przy awarii i wyrenderowane podsumowanie.
- `payment-retry.test.ts`: body checkoutu, 4xx, ponawianie po anulowaniu,
  wygasanie, zakup już opłacony i zgodność starego POST bez punktów.
- Ręcznie po integracji: przy cenie 60 zł wpisz 1000 → dopłata 50 zł;
  wpisz 1001 → błąd; zmniejsz saldo w mocku do 300 i odśwież → blokada
  starego wyboru; wybierz „Bez punktów” → dopłata 60 zł.
