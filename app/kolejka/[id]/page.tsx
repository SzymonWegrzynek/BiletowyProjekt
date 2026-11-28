import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WaitlistStatus } from "@/components/WaitlistStatus";
import { waitlistIdSchema } from "@/lib/waitlist";

export const metadata: Metadata = {
  title: "Lista oczekujących",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default async function WaitlistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!waitlistIdSchema.safeParse(id).success) notFound();
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <WaitlistStatus key={id} id={id} />
    </main>
  );
}
