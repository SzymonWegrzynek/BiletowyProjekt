import { ObjectId } from "mongodb";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  getDb,
  reservationsCollection,
} from "../lib/db.ts";
import type { Event, Reservation } from "../lib/schemas.ts";

const EVENTS: Event[] = [
  {
    _id: "dziady",
    title: "Dziady",
    date: "2026-11-14",
    time: "19:00",
    stage: "Duża Scena",
  },
  {
    _id: "wesele",
    title: "Wesele",
    date: "2026-11-21",
    time: "19:00",
    stage: "Duża Scena",
  },
  {
    _id: "kordian",
    title: "Kordian",
    date: "2026-11-28",
    time: "18:00",
    stage: "Scena Kameralna",
  },
];

const PURCHASED_SEATS = [
  { eventId: "dziady", seatId: "A1", code: "TEA-7F3K9Q" },
  { eventId: "dziady", seatId: "F7", code: "TEA-4M8R2W" },
  { eventId: "wesele", seatId: "C5", code: "TEA-9K3D6H" },
  { eventId: "kordian", seatId: "B3", code: "TEA-5Q7N2X" },
  { eventId: "kordian", seatId: "H10", code: "TEA-8W4J6P" },
] as const;

async function setupDatabase() {
  const databaseName = process.env.MONGODB_DB ?? process.env.MONGODB_DB_TEST;
  if (!process.env.MONGODB_URI || !databaseName) {
    throw new Error(
      "Ustaw MONGODB_URI oraz MONGODB_DB (lub MONGODB_DB_TEST) w pliku .env",
    );
  }

  try {
    const database = getDb();
    console.info(`Przygotowuję bazę: ${databaseName}`);
    await database.collection("reservations").deleteMany({});
    await database.collection("events").deleteMany({});

    await ensureIndexes();
    await eventsCollection().insertMany(EVENTS);

    const now = new Date();
    const reservations: Reservation[] = PURCHASED_SEATS.map(
      ({ eventId, seatId, code }) => ({
        _id: new ObjectId(),
        eventId,
        seatId,
        customerName: "Gość przykładowy",
        email: "bilet@example.com",
        status: "purchased",
        expiresAt: now,
        code,
        createdAt: now,
      }),
    );
    await reservationsCollection().insertMany(reservations);

    console.info(
      `Gotowe: ${EVENTS.length} spektakle, ${reservations.length} kupionych miejsc, indeksy reservations.`,
    );
  } finally {
    await getClient().close();
  }
}

setupDatabase().catch((error: unknown) => {
  console.error("Nie udało się przygotować bazy danych:", error);
  process.exitCode = 1;
});
