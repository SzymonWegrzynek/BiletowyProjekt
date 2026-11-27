import type { LoyaltyCard } from "@/lib/voucherify";

// Voucherify w pamięci: karty, salda i transakcje. Testy nigdy nie pytają
// prawdziwego API (Sandbox ma limit 100 wywołań na godzinę).
export type FakeTransaction = {
  cardCode: string;
  points: number;
  sourceId: string;
  reason: string;
};

type Failure = (call: { points?: number; sourceId?: string }) => unknown;

export function createFakeVoucherify() {
  const balances = new Map<string, number>(); // kod karty → saldo
  const cardsByEmail = new Map<string, string>();
  const transactions: FakeTransaction[] = [];
  let nextCard = 0;
  // Kolejne awarie do zwrócenia zamiast odpowiedzi (np. timeout, 429).
  const failures = {
    join: [] as Failure[],
    get: [] as Failure[],
    adjust: [] as Failure[],
  };

  // Mała przerwa, żeby równoległe wywołania naprawdę się przeplatały.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  function card(code: string): LoyaltyCard {
    const balance = balances.get(code);
    if (balance === undefined) throw new Error(`Nieznana karta ${code}`);
    return { cardCode: code, balance };
  }

  return {
    transactions,
    failures,

    // join_once: klient ma w kampanii jedną kartę.
    async join(email: string): Promise<LoyaltyCard> {
      await tick();
      const failure = failures.join.shift();
      if (failure) throw failure({});
      let code = cardsByEmail.get(email);
      if (!code) {
        code = `LC-${++nextCard}`;
        cardsByEmail.set(email, code);
        balances.set(code, 0);
      }
      return card(code);
    },

    async get(code: string): Promise<LoyaltyCard> {
      await tick();
      const failure = failures.get.shift();
      if (failure) throw failure({});
      return card(code);
    },

    async adjust(
      code: string,
      points: number,
      { sourceId, reason }: { sourceId: string; reason: string },
    ): Promise<{ balance?: number }> {
      await tick();
      const failure = failures.adjust.shift();
      if (failure) throw failure({ points, sourceId });
      const balance = card(code).balance + points;
      balances.set(code, balance);
      transactions.push({ cardCode: code, points, sourceId, reason });
      return { balance };
    },

    cardOf(email: string): string | undefined {
      return cardsByEmail.get(email);
    },

    // Zmiana salda poza aplikacją (inny kanał sprzedaży, panel Voucherify).
    setBalance(email: string, balance: number) {
      const code = cardsByEmail.get(email);
      if (!code) throw new Error(`Brak karty dla ${email}`);
      balances.set(code, balance);
    },
  };
}

export type FakeVoucherify = ReturnType<typeof createFakeVoucherify>;
