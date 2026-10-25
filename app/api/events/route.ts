import { connection } from "next/server";
import { eventsCollection } from "@/lib/db";

export async function GET() {
  // Bez tego build prerenderuje listę i zamraża ją do następnego deployu.
  await connection();
  const events = await eventsCollection()
    .find({}, { projection: { _id: 1, title: 1, date: 1, time: 1, stage: 1 } })
    .sort({ date: 1, time: 1 })
    .toArray();
  return Response.json(events);
}
