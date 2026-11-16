import type { Metadata } from "next";
import { EventCatalog } from "@/components/EventCatalog";

export const metadata: Metadata = { title: "Repertuar" };

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <section className="pt-10 pb-10 sm:pt-16 sm:pb-14">
        <p className="label">Sezon teatralny</p>
        <h1 className="title mt-3 text-6xl sm:text-7xl">Repertuar</h1>
        <p className="mt-4 max-w-md text-muted">
          Wybierz spektakl, a potem swój fotel na widowni.
        </p>
      </section>

      <EventCatalog />
    </main>
  );
}
