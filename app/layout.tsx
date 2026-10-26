import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Kasa biletowa teatru",
    template: "%s · Kasa biletowa teatru",
  },
  description: "Rezerwacja i zakup biletów na spektakle",
};

export const viewport: Viewport = {
  themeColor: "#1d1c1b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="pl"
      className={`${inter.variable} ${cormorant.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="title text-2xl focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
          >
            Teatr
          </Link>
          <span className="label text-muted">Kasa biletowa</span>
        </header>

        <div className="flex flex-1 flex-col pb-16">{children}</div>
      </body>
    </html>
  );
}
