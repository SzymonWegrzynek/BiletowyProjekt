import type { Metadata } from "next";
import { EventCatalog } from "@/components/EventCatalog";

export const metadata: Metadata = { title: "Repertuar" };

export default function Home() {
  return (
    <main className="home-main">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Mały plan na wielki wieczór</p>
          <h1>
            Usiądź bliżej
            <br />
            <em>dobrej historii.</em>
          </h1>
          <p className="hero-description">
            Zostaw codzienność za kulisami. Wybierz spektakl, znajdź swoje
            miejsce i daj się porwać opowieści.
          </p>
          <a href="#repertuar" className="hero-link">
            Odkryj repertuar <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="hero-art" aria-hidden="true">
          <svg viewBox="0 0 440 340" fill="none">
            <defs>
              <path
                id="star"
                d="M0 -83 Q9 -86 18 -45 L27 -24 L73 -26 Q94 -25 77 -5 L44 22 L53 67 Q56 89 36 78 L0 56 L-37 78 Q-58 89 -53 65 L-44 22 L-78 -7 Q-95 -26 -72 -26 L-27 -24 L-12 -70 Q-7 -85 0 -83Z"
              />
            </defs>
            <use
              href="#star"
              transform="translate(104 120) rotate(-12)"
              fill="#f9dc8b"
              stroke="#fff4de"
              strokeWidth="5"
            />
            <use
              href="#star"
              transform="translate(218 163) rotate(8)"
              fill="#ed9b37"
              stroke="#fff4de"
              strokeWidth="5"
            />
            <use
              href="#star"
              transform="translate(332 205) rotate(22)"
              fill="#ae4826"
              stroke="#fff4de"
              strokeWidth="5"
            />
            <path
              d="M55 256 Q180 316 355 290"
              stroke="#f9dc8b"
              strokeWidth="2"
              strokeDasharray="3 8"
            />
          </svg>
          <span className="art-caption">Światła gasną. Emocje zostają.</span>
        </div>
      </header>
      <section id="repertuar" aria-labelledby="repertuar-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Wybierz swój wieczór</p>
            <h2 id="repertuar-title">Na naszej scenie</h2>
          </div>
          <p>Spektakl. Miejsce. Do zobaczenia.</p>
        </div>
        <EventCatalog />
      </section>
    </main>
  );
}
