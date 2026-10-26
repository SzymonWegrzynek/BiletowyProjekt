import type { Metadata } from "next";
import { SeatSelection } from "@/components/SeatSelection";

export const metadata: Metadata = { title: "Wybór miejsca" };

export default async function EventPage({
  params,
}: PageProps<"/spektakl/[id]">) {
  const { id } = await params;

  return <SeatSelection eventId={id} />;
}
