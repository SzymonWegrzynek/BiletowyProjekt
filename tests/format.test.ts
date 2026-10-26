import { describe, expect, it } from "vitest";
import { formatCountdown, formatEventDate, formatSeat } from "@/lib/format";

describe("formatSeat", () => {
  it.each([
    ["F7", "Rząd F, miejsce 7"],
    ["A1", "Rząd A, miejsce 1"],
    ["H10", "Rząd H, miejsce 10"],
  ])("%s → %s", (seatId, expected) => {
    expect(formatSeat(seatId)).toBe(expected);
  });
});

describe("formatCountdown", () => {
  it.each([
    [15 * 60_000, "15:00"],
    [65_000, "01:05"],
    [59_001, "01:00"],
    [1, "00:01"],
    [0, "00:00"],
    [-5_000, "00:00"],
  ])("%i ms → %s", (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});

describe("formatEventDate", () => {
  it("rozbija datę na polskie części w dopełniaczu", () => {
    expect(formatEventDate("2026-11-14")).toEqual({
      weekday: "sobota",
      day: "14",
      month: "listopada",
      year: "2026",
      long: "sobota, 14 listopada 2026",
    });
  });

  it("zwraca null dla niepoprawnej daty", () => {
    expect(formatEventDate("jutro")).toBeNull();
  });
});
