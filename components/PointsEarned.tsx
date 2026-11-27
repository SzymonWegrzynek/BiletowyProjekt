import { pointsSchema } from "@/lib/loyalty";

export function PointsEarned({ pointsEarned }: { pointsEarned?: number }) {
  const parsed = pointsSchema.safeParse(pointsEarned);
  return (
    <div className="card p-4">
      <dt className="text-sm text-muted">Zdobyte punkty</dt>
      <dd className="numerals mt-1 text-xl font-semibold text-ink">
        {parsed.success
          ? parsed.data.toLocaleString("pl-PL")
          : "Informacja o nagrodzie jest jeszcze niedostępna."}
      </dd>
    </div>
  );
}
