import { connection } from "next/server";
import { STUB_EVENTS } from "@/lib/stubs";

// TODO(karta A): czytać z kolekcji events.
export async function GET() {
  // Bez tego build prerenderuje listę i zamraża ją do następnego deployu.
  await connection();
  return Response.json(STUB_EVENTS);
}
