# Powrót po przerwanej płatności

Po udanej płatności backend powinien ustawić `success_url` na
`${APP_URL}/rezerwacja/${reservationId}/platnosc`. Ta strona odczytuje status
z API od razu, następnie co 2 sekundy, a po 30 sekundach co 10 sekund.
Wtedy pokazuje informację o opóźnieniu i „Sprawdź ponownie”. Ręczne sprawdzenie
nie resetuje czasu oczekiwania ani nie uruchamia równoległych zapytań.
Zapytanie bez odpowiedzi jest przerywane po 10 sekundach i ponawiane.
`paid` z kodem prowadzi na bilet;
`expired` i 404 kończą oczekiwanie. Błąd sieci jest ponawiany. Opuszczenie
strony anuluje request i timer. Parametry URL nie są dowodem płatności.

Frontend obsługuje `/rezerwacja/:id?anulowano=1`. Backend Stripe powinien
ustawić `cancel_url` na `${APP_URL}/rezerwacja/${reservationId}?anulowano=1`.
Parametr wyświetla komunikat, ale nie zmienia statusu ani czasu rezerwacji.

Ponowne „Zapłać” sprawdza `GET /api/reservations/:id`, następnie wywołuje
`POST /api/reservations/:id/checkout`. Te endpointy są zależnościami Etapu II
i nie są jeszcze zaimplementowane w tym repozytorium. Wszystkie wejścia na
rezerwację używają teraz wspólnego `CheckoutButton` z kwotą `amount` zapisaną
w rezerwacji. Pierwsza próba wywołuje bezpośrednio checkout, a po 409 odczytuje
status. Powrót po anulowaniu sprawdza status również przed checkoutem.
Starsze rezerwacje bez `amount` pokazują informację o niedostępności płatności;
frontend nie zastępuje tej kwoty aktualną ceną spektaklu.
Plik `PurchaseTicketButton` i endpoint `/purchase` pozostają dla Etapu I,
ale ekran rezerwacji już ich nie używa.

Po wdrożeniu backendu sprawdzić w trybie testowym Stripe:

1. Przerwać płatność i wrócić: komunikat, ten sam termin wygaśnięcia, „Zapłać”.
2. Ponowić płatność i potwierdzić przejście na bilet po webhooku.
3. Wrócić po wygaśnięciu: komunikat i link do widowni, bez przycisku płatności.
4. Opłacić w drugiej karcie: powrót lub ponowienie kieruje na istniejący bilet.
5. Użyć testowej karty odmowy `4000 0000 0000 0002`, wybrać powrót
   i sprawdzić adres z `anulowano=1`.

Testy automatyczne sprawdzają kontrakt frontendu na zamockowanych odpowiedziach;
nie zastępują powyższego testu integracji Stripe.
