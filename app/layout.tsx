import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Kasa biletowa teatru",
    template: "%s · Kasa biletowa teatru",
  },
  description: "Rezerwacja i zakup biletów na spektakle",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pl" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <header className="border-b border-gray-200">
          <nav className="site-nav" aria-label="Nawigacja główna">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                ✳
              </span>{" "}
              scena.
            </Link>
            <Link href="/#repertuar" className="nav-link">
              Repertuar <span aria-hidden="true">↗</span>
            </Link>
          </nav>
        </header>
        {children}
        <footer className="site-footer">
          <span>scena. / Dobre historie zaczynają się tutaj.</span>
          <span>Twój wieczór w teatrze.</span>
        </footer>
      </body>
    </html>
  );
}
