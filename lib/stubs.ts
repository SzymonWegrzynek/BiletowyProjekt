import type { Event } from "@/lib/schemas";

// Zaślepki do czasu podpięcia bazy — front może na nich budować ekrany.
export const STUB_EVENTS: Event[] = [
  {
    _id: "dziady",
    title: "Dziady",
    date: "2026-11-14",
    time: "19:00",
    stage: "Duża Scena",
  },
  {
    _id: "wesele",
    title: "Wesele",
    date: "2026-11-21",
    time: "19:00",
    stage: "Duża Scena",
  },
  {
    _id: "kordian",
    title: "Kordian",
    date: "2026-11-28",
    time: "18:00",
    stage: "Scena Kameralna",
  },
];

export const STUB_TAKEN_SEATS = ["A1", "A2", "C5", "F7"];

export const STUB_TICKET_CODE = "TEA-7F3K9Q";
