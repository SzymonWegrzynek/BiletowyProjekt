import type { Metadata } from "next";
import { EventCatalog } from "@/components/EventCatalog";

export const metadata: Metadata = { title: "Repertuar" };

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-gray-300 pb-6">
        <p className="text-sm font-semibold uppercase tracking-wider text-emerald-800">
          Teatr
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-gray-950 sm:text-4xl">
          Repertuar
        </h1>
        <p className="mt-2 max-w-xl text-gray-600">
          Wybierz spektakl, aby sprawdzić dostępne miejsca.
        </p>
      </header>
      <EventCatalog />
    </main>
  );
}
