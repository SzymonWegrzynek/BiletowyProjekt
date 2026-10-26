import Link from "next/link";

export default function EventNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">Nie ma takiego spektaklu</h1>
      <Link href="/" className="underline">
        Wróć do repertuaru
      </Link>
    </main>
  );
}
