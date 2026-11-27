import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPointsPreview } from "@/lib/checkout-points";
import { CheckoutPoints } from "@/components/CheckoutPoints";
import type { LoyaltyState } from "@/lib/loyalty";

const balance: LoyaltyState = { status: "ready", points: 1000 };

describe("wybór punktów", () => {
  it("60 zł minus 1000 punktów daje 50 zł kartą", () => {
    expect(getPointsPreview(6000, "1000", balance)).toEqual({
      valid: true,
      points: 1000,
      cardAmount: 5000,
      maximum: 1000,
      limit: 3000,
    });
  });
  it.each([
    [6000, 1000, 1000],
    [6000, 9000, 3000],
    [4551, 9000, 2275],
    [6000, 0, 0],
  ])("limit dla ceny %s i salda %s wynosi %s", (amount, points, maximum) => {
    const current: LoyaltyState = { status: "ready", points };
    expect(getPointsPreview(amount, String(maximum), current)).toMatchObject({
      valid: true,
      maximum,
      cardAmount: amount - maximum,
    });
    expect(getPointsPreview(amount, String(maximum + 1), current).valid).toBe(
      false,
    );
  });
  it.each([
    "",
    "-1",
    "1.5",
    "1,5",
    "1e3",
    "+1",
    "abc",
    "Infinity",
    "9007199254740992",
    "1001",
  ])("nie akceptuje niepoprawnego wyboru %s", (value) => {
    expect(getPointsPreview(6000, value, balance).valid).toBe(false);
  });
  it.each(["loading", "error"] as const)(
    "przy stanie %s umożliwia tylko zakup bez punktów",
    (status) => {
      expect(getPointsPreview(6000, "0", { status })).toMatchObject({
        valid: true,
        cardAmount: 6000,
      });
      expect(getPointsPreview(6000, "1000", { status }).valid).toBe(false);
    },
  );
  it("spadek salda blokuje poprzedni wybór bez cichego zwiększania dopłaty", () => {
    expect(getPointsPreview(6000, "1000", balance).valid).toBe(true);
    const reduced: LoyaltyState = { status: "ready", points: 300 };
    expect(getPointsPreview(6000, "1000", reduced)).toMatchObject({
      valid: false,
      maximum: 300,
    });
    expect(getPointsPreview(6000, "300", reduced)).toMatchObject({
      valid: true,
      cardAmount: 5700,
    });
    expect(getPointsPreview(6000, "0", reduced)).toMatchObject({
      valid: true,
      cardAmount: 6000,
    });
  });
  it("dokładnie zachowuje grosze dopłaty", () => {
    expect(getPointsPreview(4551, "1000", balance)).toMatchObject({
      valid: true,
      cardAmount: 3551,
    });
  });
});

describe("podsumowanie punktów", () => {
  const render = (
    value: string,
    current: LoyaltyState = balance,
    disabled = false,
  ) =>
    renderToStaticMarkup(
      createElement(CheckoutPoints, {
        amount: 6000,
        value,
        balance: current,
        disabled,
        onChange: () => {},
        onRefresh: () => {},
      }),
    );
  it("pokazuje kurs, limit oraz podsumowanie przeliczone z aktualnego wyboru", () => {
    const initial = render("0");
    const selected = render("1000");
    expect(initial).toContain("60 zł</dd>");
    expect(selected).toContain("50 zł</dd>");
    expect(selected).toContain("10 zł)");
    expect(selected).toContain("1 punkt = 1 grosz");
    expect(selected).toContain('max="1000"');
    expect(selected).toContain('step="1"');
    expect(selected).toContain("Użyj punktów");
  });
  it("błędna wartość ma dostępny komunikat i nie pokazuje fikcyjnej dopłaty", () => {
    const html = render("1001");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="checkout-points-error"');
    expect(html).toContain("—</dd>");
    expect(html).not.toContain("49,99 zł");
  });
  it("błąd salda pozostawia akcję zakupu bez punktów", () => {
    const html = render("0", { status: "error" });
    expect(html).toContain("Nie udało się pobrać salda");
    expect(html).toContain("Bez punktów");
    expect(html).toContain("Odśwież saldo");
    expect(html).toContain("60 zł</dd>");
  });
  it("podczas płatności blokuje pole oraz obie akcje punktowe", () => {
    const html = render("1000", balance, true);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
