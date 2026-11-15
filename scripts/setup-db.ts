import {
  SEED_EVENTS as EVENTS,
  createSeedReservations,
} from "../lib/seed-data.ts";
import {
  ensureIndexes,
  eventsCollection,
  getClient,
  getDb,
  reservationsCollection,
} from "../lib/db.ts";

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
    const reservations = createSeedReservations(now);
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
