import { apiError } from "@/lib/errors";
import { STUB_EVENTS, STUB_TAKEN_SEATS } from "@/lib/stubs";

// TODO(karta A): event z bazy, takenSeats przez activeReservationFilter(now).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const event = STUB_EVENTS.find((e) => e._id === id);
  if (!event) return apiError("NOT_FOUND", "Nie ma takiego spektaklu");

  return Response.json({ event, takenSeats: STUB_TAKEN_SEATS });
}
