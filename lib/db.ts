import { MongoClient, type Db } from "mongodb";
import type { Event, Reservation } from "./schemas.ts";

// Jeden klient na proces: hot reload w dev nie może otwierać nowych połączeń.
const globalForMongo = globalThis as typeof globalThis & {
  _mongoClient?: MongoClient;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Brak zmiennej środowiskowej ${name}`);
  return value;
}

export function getClient(): MongoClient {
  globalForMongo._mongoClient ??= new MongoClient(requireEnv("MONGODB_URI"));
  return globalForMongo._mongoClient;
}

export function getDb(): Db {
  return getClient().db(requireEnv("MONGODB_DB"));
}

export function eventsCollection() {
  return getDb().collection<Event>("events");
}

export function reservationsCollection() {
  return getDb().collection<Reservation>("reservations");
}

// Indeksy pilnują invariantów: jedno miejsce = jeden dokument, jeden kod = jeden bilet.
// createIndex jest idempotentne. Wołają to `pnpm db:setup` i testy.
export async function ensureIndexes(): Promise<void> {
  const reservations = reservationsCollection();
  await reservations.createIndex({ eventId: 1, seatId: 1 }, { unique: true });
  await reservations.createIndex(
    { code: 1 },
    { unique: true, partialFilterExpression: { code: { $exists: true } } },
  );
}
