import { describe, it, expect } from "vitest";
import { extractFields, receiptTextLines } from "../server/services/ocr.js";
const receipt = [
  "Оплата совершена",
  "2 345 ₸",
  "ИП СЫНАҚ ДҮКЕН",
  "№ чека QR-TEST-2026",
  "ИИН/БИН продавца 000000000001",
  "ФИО покупателя Сынақ А.",
  "Дата и время",
  "по Астане",
  "14.11.2026 23:52",
  "Оплачено с Kaspi Gold",
];
describe("QR receipt layout", () => {
  it("reads the unlabeled amount, merchant, receipt number, timezone date and method", () => {
    expect(extractFields(receipt.join("\n"), "receipt")).toMatchObject({
      amount: 234500,
      paymentDate: "2026-11-14",
      receiptNumber: "QR-TEST-2026",
      recipientName: "ИП СЫНАҚ ДҮКЕН",
      method: "с Kaspi Gold",
    });
  });
  it("does not invent an amount from IIN, a failed payment, or unrelated digits", () => {
    for (const lines of [
      ["Оплата совершена", "000000000001", "ИИН/БИН продавца"],
      ["Оплата отклонена", "2 345 ₸"],
      ["Оплата совершена", "Комиссия", "12 ₸", "Справка"],
    ]) {
      expect(extractFields(lines.join("\n"), "receipt").amount).toBeUndefined();
    }
  });
  it("reconstructs rows instead of trusting PDF content-stream order", () => {
    const item = (text: string, x: number, y: number) => ({
      text,
      bbox: { x0: x, x1: x + 80, y0: y - 10, y1: y },
    });
    const text = receiptTextLines([
      item("Дата и время", 10, 100),
      item("по Астане", 10, 114),
      item("14.11.2026 23:52", 200, 100),
      item("№ чека", 10, 50),
      item("QR-TEST-2026", 200, 50),
    ]);
    expect(extractFields(text, "receipt")).toMatchObject({
      paymentDate: "2026-11-14",
      receiptNumber: "QR-TEST-2026",
    });
  });
});
