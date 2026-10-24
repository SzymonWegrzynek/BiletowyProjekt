import { ObjectId } from "mongodb";
import { apiError } from "@/lib/errors";
import { STUB_TICKET_CODE } from "@/lib/stubs";

// TODO(karta C): findOneAndUpdate z warunkiem held + expiresAt > now.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  }

  return Response.json({ code: STUB_TICKET_CODE }, { status: 201 });
}
