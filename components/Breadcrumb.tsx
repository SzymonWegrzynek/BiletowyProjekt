import Link from "next/link";

// „← REPERTUAR • DZIADY” — powrót o poziom wyżej i nazwa bieżącego ekranu.
export function Breadcrumb({
  href,
  back,
  current,
}: {
  href: string;
  back: string;
  current: string;
}) {
  return (
    <nav
      aria-label="Okruszki"
      className="flex items-center gap-3 text-[11px] font-medium tracking-[0.18em] uppercase"
    >
      <Link
        href={href}
        className="inline-flex items-center gap-2 text-gold/70 transition-colors hover:text-gold focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M19 12H5m6-6-6 6 6 6" />
        </svg>
        {back}
      </Link>
      <span aria-hidden="true" className="text-muted">
        •
      </span>
      <span aria-current="page" className="truncate text-gold">
        {current}
      </span>
    </nav>
  );
}
