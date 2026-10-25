import { describe, expect, it } from "vitest";
import { formatCountdown, formatSeat } from "@/lib/format";

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
