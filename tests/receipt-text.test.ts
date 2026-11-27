import { describe, expect, it } from "vitest";
import { extractReceiptText } from "../server/services/document-fields.js";
const receipt =
  'Оплата совершена 6 437 ₸ ОО Сынақ ұйымы "TEST" № чека QR-TEXT-001 ИИН/БИН продавца 000000000001 ФИО покупателя Үлгі А. сіңлісі төлепті Дата и время по Астане 01.08.2026 16:00 Оплачено с Kaspi Gold Адрес г. Астана, Е 15';
describe("WhatsApp receipt text", () => {
  const shortReceipt = [
    "Оплата 6 245 ₸",
    "ОО Сынақ бірлестігі",
    'Қолөнершілер "URSHYK" (Ұршық)',
    "№ чека QR00000001425",
    "ИИН/БИН продавца 000000000001",
    "ФИО покупателя Үлгі А.",
    "Дата и время",
    "по Астане",
    "17.06.2026 09:03",
    "Оплачено с Kaspi Gold",
    "Адрес Тест көшесі, 15",
  ];
  it.each(["\n", "\\\n", "\\", " "])(
    "reads the short Kaspi heading and the entire wrapped merchant with separator %j",
    (separator) => {
      expect(extractReceiptText(shortReceipt.join(separator))).toEqual({
        amount: 624500,
        paymentDate: "2026-06-17",
        paymentTime: "09:03",
        receiptNumber: "QR00000001425",
        payerName: "Үлгі А.",
        recipientName: 'ОО Сынақ бірлестігі Қолөнершілер "URSHYK" (Ұршық)',
        receiptType: "urshyk",
        method: "с Kaspi Gold",
      });
    },
  );
  it("requires a receipt number heading to interpret a short payment message as a receipt amount", () => {
    expect(extractReceiptText("Оплата 6 245 ₸ до 17 июня")).toEqual({});
  });
  it("rejects a short receipt combined with another payment", () => {
    expect(() =>
      extractReceiptText(receipt + "\n" + shortReceipt.join("\n")),
    ).toThrow("бір чектің");
  });
  it.each([
    receipt,
    receipt.replace("№ чека", "№чека"),
    "➕ Сынақ Үлгі-1956 TEST NAME 5 23 ҮЙ +7 000 000 0001 ——————————" + receipt,
    receipt.replaceAll(" ", "\n"),
  ])(
    "reads receipt fields without mistaking a profile, phone, buyer or address for payment details",
    (text) => {
      expect(extractReceiptText(text)).toEqual({
        amount: 643700,
        paymentDate: "2026-08-01",
        paymentTime: "16:00",
        receiptNumber: "QR-TEXT-001",
        payerName: "Үлгі А.",
        recipientName: 'ОО Сынақ ұйымы "TEST"',
        method: "с Kaspi Gold",
      });
    },
  );
  it("refuses to merge two payments from a conversation", () => {
    expect(() => extractReceiptText(receipt + "\n" + receipt)).toThrow(
      "бір чектің",
    );
  });
  it("does not make up receipt values for an unrelated message", () => {
    expect(extractReceiptText("Сынақ 1956 23 үй +7 000 000 0001")).toEqual({});
  });
});
