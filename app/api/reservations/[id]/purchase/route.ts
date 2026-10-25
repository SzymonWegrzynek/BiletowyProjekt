import { MongoServerError, ObjectId } from "mongodb";
import { reservationsCollection } from "@/lib/db";
import { apiError } from "@/lib/errors";
import { generateTicketCode } from "@/lib/ticket";

const DUPLICATE_KEY = 11000;
const MAX_CODE_ATTEMPTS = 3;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  }

  const _id = new ObjectId(id);
  const now = new Date();
  const reservations = reservationsCollection();

  // Jeden warunkowy zapis: bilet powstaje tylko z ważnej rezerwacji "held".
  // Przy równoczesnych zakupach wygrywa dokładnie jeden — dla reszty filtr
  // już nie pasuje. E11000 może tu dać tylko kolizja kodu → losujemy nowy.
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    try {
      const updated = await reservations.findOneAndUpdate(
        { _id, status: "held", expiresAt: { $gt: now } },
        { $set: { status: "purchased", code: generateTicketCode() } },
        { returnDocument: "after" },
      );
      if (updated) {
        return Response.json({ code: updated.code }, { status: 201 });
      }
      break;
    } catch (error) {
      const codeCollision =
        error instanceof MongoServerError && error.code === DUPLICATE_KEY;
      if (!codeCollision || attempt === MAX_CODE_ATTEMPTS) throw error;
    }
  }

  // Zapis nic nie zmienił — tylko odczyt, żeby powiedzieć dlaczego.
  const existing = await reservations.findOne(
    { _id },
    { projection: { status: 1, code: 1 } },
  );
  if (!existing) return apiError("NOT_FOUND", "Nie ma takiej rezerwacji");
  if (existing.status === "purchased") {
    // Ponowny zakup (np. podwójny klik) zwraca ten sam bilet.
    return Response.json({ code: existing.code }, { status: 200 });
  }
  return apiError("RESERVATION_EXPIRED");
}
