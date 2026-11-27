import { loyaltyOperationsCollection, reservationsCollection } from "./db.ts";
import { applyLoyaltyOperation } from "./loyalty-operations.ts";
import { settlePurchaseReward } from "./loyalty-rewards.ts";
import { findUnreturnedSpends, releaseSpendIfUnused } from "./loyalty-spend.ts";
import { LoyaltyUnavailableError } from "./voucherify.ts";

// Zaległe rozliczenia punktów po awarii Voucherify: nagrody za opłacone bilety
// i operacje, które nie doszły do końca. Dokańczanie jest bezpieczne do
// ponawiania — każda operacja wykonuje się najwyżej raz (lib/loyalty-operations).

// Operacje, które wolno dokończyć bez udziału klienta: dopisanie punktów
// (bonus, nagroda) i zwrot wydanych. Potrącenia (redeem:) NIE — potrącenie
// dokończone po fakcie zabrałoby punkty za płatność, której klient mógł nie
// dokończyć. Wykonane potrącenia z rezerwacji, która wygasła albo zniknęła,
// zwracamy (releaseSpendIfUnused).
const AUTO_FINISH = /^(bonus|earn|return):/;

const UNFINISHED = ["pending", "applying", "unknown"] as const;

export type PendingLoyaltyWork = {
  rewards: {
    reservationId: string;
    email: string;
    pointsEarned: number;
    paidAt?: Date;
  }[];
  operations: {
    id: string;
    status: string;
    points: number;
    attempts: number;
    updatedAt: Date;
    lastError?: string;
    autoFinish: boolean;
  }[];
  failed: { id: string; points: number; lastError?: string }[];
};

// Zawężenie do klientów (np. --email=… w skrypcie albo domena w testach).
export type LoyaltyWorkScope = { limit?: number; email?: string | RegExp };

export async function listPendingLoyaltyWork({
  limit = 100,
  email,
}: LoyaltyWorkScope = {}): Promise<PendingLoyaltyWork> {
  const byEmail = email === undefined ? {} : { email };
  const [rewards, operations, failed] = await Promise.all([
    reservationsCollection()
      .find(
        { status: "purchased", pointsEarnedStatus: "pending", ...byEmail },
        { projection: { email: 1, pointsEarned: 1, paidAt: 1 } },
      )
      .sort({ paidAt: 1 })
      .limit(limit)
      .toArray(),
    loyaltyOperationsCollection()
      .find({ status: { $in: [...UNFINISHED] }, ...byEmail })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray(),
    loyaltyOperationsCollection()
      .find({ status: "failed", ...byEmail })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray(),
  ]);

  return {
    rewards: rewards.map((r) => ({
      reservationId: r._id.toHexString(),
      email: r.email,
      pointsEarned: r.pointsEarned ?? 0,
      paidAt: r.paidAt,
    })),
    operations: operations.map((o) => ({
      id: o._id,
      status: o.status,
      points: o.points,
      attempts: o.attempts,
      updatedAt: o.updatedAt,
      lastError: o.lastError,
      autoFinish: AUTO_FINISH.test(o._id),
    })),
    failed: failed.map((o) => ({
      id: o._id,
      points: o.points,
      lastError: o.lastError,
    })),
  };
}

export type FinishReport = {
  finished: number; // rozliczone teraz (także zwroty punktów)
  waiting: number; // w toku albo jeszcze nie do rozstrzygnięcia
  errors: number; // Voucherify nadal nie odpowiada / odrzucił
  stoppedByLimit: boolean; // przerwane, żeby nie przedłużać limitu zapytań
};

// Dokańcza zaległe rozliczenia, najwyżej `limit` pozycji na uruchomienie
// (Sandbox ma 100 wywołań API na godzinę). Na limicie zapytań przerywa.
// Kolejność: nagrody za bilety, zwroty punktów z nieopłaconych rezerwacji,
// pozostałe niedokończone operacje (bonus, nagroda, zwrot).
export async function finishPendingLoyaltyWork({
  limit = 20,
  email,
}: LoyaltyWorkScope = {}): Promise<FinishReport> {
  const byEmail = email === undefined ? {} : { email };
  const report: FinishReport = {
    finished: 0,
    waiting: 0,
    errors: 0,
    stoppedByLimit: false,
  };
  let budget = limit;

  const onError = (error: unknown) => {
    report.errors += 1;
    console.error(error);
    if (
      error instanceof LoyaltyUnavailableError &&
      error.outcome === "not_applied" &&
      error.retryAfterSeconds !== undefined
    ) {
      report.stoppedByLimit = true;
    }
  };

  // Najpierw nagrody za bilety — settlePurchaseReward dokańcza też ich operację.
  const rewards = await reservationsCollection()
    .find(
      { status: "purchased", pointsEarnedStatus: "pending", ...byEmail },
      { projection: { _id: 1 } },
    )
    .sort({ paidAt: 1 })
    .limit(budget)
    .toArray();
  for (const { _id } of rewards) {
    if (report.stoppedByLimit || budget <= 0) break;
    budget -= 1;
    try {
      const result = await settlePurchaseReward(_id);
      if (result === "done") report.finished += 1;
      else if (result === "pending") report.waiting += 1;
    } catch (error) {
      onError(error);
    }
  }

  // Punkty wydane na rezerwację, która wygasła albo zniknęła — wracają.
  const spends = await findUnreturnedSpends({
    email,
    limit: Math.max(budget, 0),
  });
  for (const spendId of spends) {
    if (report.stoppedByLimit || budget <= 0) break;
    try {
      const result = await releaseSpendIfUnused(spendId);
      if (result === "kept") continue; // rezerwacja ważna albo opłacona
      budget -= 1;
      if (result === "returned" || result === "cancelled") {
        report.finished += 1;
      }
    } catch (error) {
      budget -= 1;
      onError(error);
    }
  }

  const operations = await loyaltyOperationsCollection()
    .find({
      status: { $in: [...UNFINISHED] },
      _id: { $regex: AUTO_FINISH },
      ...byEmail,
    })
    .sort({ updatedAt: 1 })
    .limit(Math.max(budget, 0))
    .toArray();
  for (const operation of operations) {
    if (report.stoppedByLimit || budget <= 0) break;
    budget -= 1;
    try {
      const result = await applyLoyaltyOperation({
        id: operation._id,
        email: operation.email,
        cardCode: operation.cardCode,
        points: operation.points,
        reason: operation.reason,
      });
      if (result.status === "done") report.finished += 1;
      else if (result.status === "in_progress") report.waiting += 1;
      else report.errors += 1;
    } catch (error) {
      onError(error);
    }
  }

  return report;
}

// Zaległe rozliczenia jednego klienta, dokańczane przy odczycie jego salda
// (GET /api/loyalty). Zastępuje harmonogram: Vercel Cron na darmowym planie
// działa raz dziennie, a punkty za zakup i zwrot punktów z wygasłej
// rezerwacji mają być widoczne w ciągu kilkunastu sekund. Gdy nic nie
// zalega, to tylko kilka odczytów z bazy — bez zapytań do Voucherify.
// Błędy tylko w logach: saldo i tak odczytamy (albo odpowiemy 503).
export const SETTLE_ON_READ_LIMIT = 3;

export async function settleCustomerLoyalty(email: string): Promise<void> {
  try {
    await finishPendingLoyaltyWork({ email, limit: SETTLE_ON_READ_LIMIT });
  } catch (error) {
    console.error(`Nie dokończono rozliczeń punktów ${email}`, error);
  }
}
