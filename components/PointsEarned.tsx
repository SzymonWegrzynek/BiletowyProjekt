import { pointsSchema } from "@/lib/loyalty";

export function PointsEarned({ pointsEarned }: { pointsEarned?: number }) {
  const parsed = pointsSchema.safeParse(pointsEarned);
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <dt className="text-sm text-gray-500">Zdobyte punkty</dt>
      <dd className="mt-1 text-xl font-semibold text-gray-900">
        {parsed.success
          ? parsed.data.toLocaleString("pl-PL")
          : "Informacja o nagrodzie jest jeszcze niedostępna."}
      </dd>
    </div>
  );
}
