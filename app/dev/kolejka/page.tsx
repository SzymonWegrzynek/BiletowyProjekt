import { notFound } from "next/navigation";
import { WaitlistDemo } from "@/components/WaitlistDemo";

export const dynamic = "force-dynamic";
export default function WaitlistPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <WaitlistDemo />;
}
