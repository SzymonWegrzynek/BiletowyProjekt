import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-12 text-center">
      <h1 className="text-3xl font-semibold text-gray-900">
        Nie ma takiego elementu
      </h1>
      <p className="text-gray-600">
        Sprawdź poprawność adresu lub wróć do repertuaru.
      </p>
      <Link
        href="/"
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white"
      >
        Wróć do repertuaru
      </Link>
    </main>
  );
}
