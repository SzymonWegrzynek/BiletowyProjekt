import Link from "next/link";

// Wspólny wygląd ekranów 404: tytuł i powrót do repertuaru.
export function NotFoundMessage({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-10 sm:px-6 sm:pt-16">
      <div className="card max-w-xl p-8 sm:p-10">
        <p className="label">Błąd 404</p>
        <h1 className="title mt-3 text-5xl">{title}</h1>
        {description && <p className="mt-4 text-muted">{description}</p>}
        <Link href="/" className="btn-secondary mt-8">
          Wróć do repertuaru
        </Link>
      </div>
    </main>
  );
}
