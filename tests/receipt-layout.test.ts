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
      payerName: "Сынақ А.",
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

describe("bank transfer receipt variants", () => {
  it("reads Halyk's wrapped receipt label and never takes the commission as amount", () => {
    expect(
      extractFields(
        [
          "Перевод по номеру телефона",
          "Перевод выполнен успешно",
          "5 000 ₸",
          "Комиссия: 0 ₸",
          "№",
          "3503000001",
          "квитанции",
          "Дата 16.10.2026 15:08",
          "Отправитель Сынақ А.",
          "Откуда • 1111",
          "Получатель Үлгі Б.",
          "Куда +7 (000) 000-00-01",
        ].join("\n"),
        "receipt",
      ),
    ).toEqual({
      amount: 500000,
      paymentDate: "2026-10-16",
      paymentTime: "15:08",
      receiptNumber: "3503000001",
      method: "• 1111",
      recipientName: "Үлгі Б.",
      receiptType: "personal",
      payerName: "Сынақ А.",
    });
  });
  it("reads a screenshot transfer with a wrapped long number, date and time", () => {
    expect(
      extractFields(
        [
          "Перевод успешно совер...",
          "175 000 т",
          "Үлгі Б.",
          "Тип перевода",
          "Перевод...",
          "№ квитанции",
          "895900000000",
          "000001",
          "Дата и время",
          "08.10.2026",
          "по Астане",
          "10:34",
          "Комиссия",
          "0 т",
          "Отправитель",
          "Сынақ А.",
          "Откуда",
          "Kaspi Gold",
        ].join("\n"),
        "receipt",
      ),
    ).toEqual({
      amount: 17500000,
      paymentDate: "2026-10-08",
      paymentTime: "10:34",
      receiptNumber: "895900000000000001",
      recipientName: "Үлгі Б.",
      receiptType: "personal",
      payerName: "Сынақ А.",
      method: "Kaspi Gold",
    });
  });
  it("keeps the complete multiline organization name", () => {
    expect(
      extractFields(
        'Оплата совершена\n6 500 ₸\nОО Сынақ ұйымы\nШеберлер "TEST"\n№ чека QR-TEST\nДата и время 15.09.2026 12:55:09',
        "receipt",
      ),
    ).toMatchObject({
      amount: 650000,
      recipientName: 'ОО Сынақ ұйымы Шеберлер "TEST"',
      receiptNumber: "QR-TEST",
      paymentTime: "12:55:09",
    });
  });
  it("does not invent payment time or take a time from a later field", () => {
    expect(
      extractFields(
        "Дата 15.09.2026\nПолучатель Сынақ\nСообщение 13:22",
        "receipt",
      ).paymentTime,
    ).toBeUndefined();
    expect(
      extractFields("Дата 15.09.2026 25:08", "receipt").paymentTime,
    ).toBeUndefined();
  });
  it("reads both validity dates without overwriting the end with the start", () => {
    for (const label of [
      "ЖАРАМДЫЛЫҚ МЕРЗІМІ",
      "ДАТА ВЫДАЧИ",
      "СРОК ДЕЙСТВИЯ",
    ]) {
      expect(
        extractFields(`${label}\n01.02.2020 — 01.02.2030`, "identity"),
      ).toMatchObject({ issueDate: "2020-02-01", expiryDate: "2030-02-01" });
    }
  });
});

it("does not substitute the recipient or metadata for a missing payer", () => {
  for (const text of ["Получатель Үлгі А.", "Отправитель\nОткуда\nKaspi Gold"])
    expect(extractFields(text, "receipt").payerName).toBeUndefined();
});
it("reads a full payer name with Kazakh letters", () => {
  expect(
    extractFields("Төлеуші: Сынақ Үлгі Айгүлқызы", "receipt").payerName,
  ).toBe("Сынақ Үлгі Айгүлқызы");
});

describe("receipt number and payment source variants", () => {
  it.each([
    ["№чека: QR 123456789", "QR123456789"],
    ["№\nчека\nQR\n123456789", "QR123456789"],
    ["№ квитанции\n001 234 567\n890", "001234567890"],
    ["QR123456789", "QR123456789"],
    ["Чек нөмірі: 001234567", "001234567"],
  ])("reads %s", (text, expected) => {
    expect(extractFields(text, "receipt").receiptNumber).toBe(expected);
  });
  it.each([
    ["Оплачено с\nKaspi\nGold", "с Kaspi Gold"],
    ["Откуда\nKaspi\nGold", "Kaspi Gold"],
    ["Оплачено с Kaspi Red", "с Kaspi Red"],
    ["Откуда Halyk Bonus", "Halyk Bonus"],
    ["Төлем тәсілі Қолма-қол", "Қолма-қол"],
    ["Откуда Kaspi GoId", "Kaspi Gold"],
  ])("keeps the printed source for %s", (text, expected) => {
    expect(extractFields(text, "receipt").method).toBe(expected);
  });
  it("does not use a seller IIN, masked card or a later field as a receipt number", () => {
    for (const text of [
      "№ чека\nИИН/БИН продавца 000000000001",
      "ИИН 000000000001",
      "№ чека\n**** 1234",
      "№ чека\nОплачено с Kaspi Gold",
    ])
      expect(extractFields(text, "receipt").receiptNumber).toBeUndefined();
  });
  it("classifies URSHYK only from the printed recipient", () => {
    expect(
      extractFields('Получатель ОО Ремесленников "URSHYK"', "receipt")
        .receiptType,
    ).toBe("urshyk");
    expect(
      extractFields("Сообщение URSHYK", "receipt").receiptType,
    ).toBeUndefined();
  });
});

it("reads the Kazakh Kaspi labels for the receipt, buyer and source", () => {
  expect(
    extractFields(
      [
        "Төлем жасалды",
        "6 487 ₸",
        'ОО Ремесленников "URSHYK"',
        "Түбіртек № QR123456789",
        "Сатушының ЖСН/БСН 000000000001",
        "Сатып алушының аты-жөні Сынақ А.",
        "Күні мен уақыты",
        "(Астана)",
        "06.08.2026 16:49",
        "Төленді Kaspi Gold",
      ].join("\n"),
      "receipt",
    ),
  ).toMatchObject({
    amount: 648700,
    receiptNumber: "QR123456789",
    payerName: "Сынақ А.",
    paymentDate: "2026-08-06",
    paymentTime: "16:49",
    method: "Kaspi Gold",
    receiptType: "urshyk",
  });
});
