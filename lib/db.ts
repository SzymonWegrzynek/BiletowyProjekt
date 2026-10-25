import dns from "node:dns";
import { MongoClient, type Db } from "mongodb";
import type { Event, Reservation } from "@/lib/schemas";

// Na Windowsie Node pyta lokalny DNS (127.0.0.1), który odrzuca zapytania SRV
// z mongodb+srv:// (querySrv ECONNREFUSED), choć nslookup działa.
if (process.platform === "win32") {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

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
