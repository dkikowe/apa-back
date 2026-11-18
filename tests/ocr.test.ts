import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { recognize } from "../server/services/ocr.js";
import { textImage, textPdf, imagePdf } from "./ocr-fixtures.js";
const receipt = [
  "SYNTHETIC RECEIPT",
  "TOTAL: 6,487.00 KZT",
  "DATE: 18.11.2026",
  "RECIPIENT: TEST ORGANIZATION",
  "RECEIPT NUMBER: TEST-2026-100",
];
const identity = [
  "SYNTHETIC IDENTITY DOCUMENT",
  "SURNAME: ULGIKYZY",
  "GIVEN NAMES: AIGUL",
  "DATE OF BIRTH: 15.04.1975",
];
describe("PDF text extraction", () => {
  it("reads a receipt without image OCR", async () =>
    expect(
      await recognize(textPdf(receipt), "application/pdf", "receipt"),
    ).toMatchObject({
      amount: 648700,
      paymentDate: "2026-11-18",
      recipientName: "TEST ORGANIZATION",
      receiptNumber: "TEST-2026-100",
    }));
  it("keeps the spelling of Latin names from a text PDF", async () =>
    expect(
      await recognize(textPdf(identity), "application/pdf", "identity"),
    ).toMatchObject({
      lastNameLatin: "ULGIKYZY",
      firstNameLatin: "AIGUL",
      birthDate: "1975-04-15",
    }));
  it("rejects a malformed PDF safely", async () => {
    await expect(
      recognize(Buffer.from("%PDF-1.7\nbroken"), "application/pdf", "receipt"),
    ).rejects.toThrow();
  });
});
describe.runIf(process.env.RUN_OCR_TESTS === "1")(
  "Real local Tesseract, synthetic documents only",
  () => {
    it("reads PNG receipt with grouped money", async () =>
      expect(
        await recognize(textImage(receipt), "image/png", "receipt"),
      ).toMatchObject({ amount: 648700, paymentDate: "2026-11-18" }));
    it("reads JPEG identity document", async () => {
      const jpg = await sharp(textImage(identity))
        .jpeg({ quality: 92 })
        .toBuffer();
      expect(await recognize(jpg, "image/jpeg", "identity")).toMatchObject({
        lastNameLatin: "ULGIKYZY",
        firstNameLatin: "AIGUL",
        birthDate: "1975-04-15",
      });
    });
    it("reads Russian receipt fields", async () => {
      expect(
        await recognize(
          textImage([
            "СИНТЕТИЧЕСКИЙ ЧЕК",
            "СУММА ПЕРЕВОДА: 1 090,00 KZT",
            "ДАТА: 18.11.2026",
            "ПОЛУЧАТЕЛЬ: ТЕСТ ОРГАНИЗАЦИЯ",
            "НОМЕР ЧЕКА: 2026100",
          ]),
          "image/png",
          "receipt",
        ),
      ).toMatchObject({
        amount: 109000,
        paymentDate: "2026-11-18",
        receiptNumber: "2026100",
      });
    });
    it("reads Kazakh identity fields", async () => {
      expect(
        await recognize(
          textImage([
            "СЫНАҚ ҚҰЖАТЫ",
            "ТЕГІ: ҮЛГІҚЫЗЫ",
            "АТЫ: АЙГҮЛ",
            "ТУҒАН КҮНІ: 15.04.1975",
          ]),
          "image/png",
          "identity",
        ),
      ).toMatchObject({
        lastName: "ҮЛГІҚЫЗЫ",
        firstName: "АЙГҮЛ",
        birthDate: "1975-04-15",
      });
    });
    it("reads scanned PDF", async () =>
      expect(
        await recognize(
          await imagePdf(textImage(receipt)),
          "application/pdf",
          "receipt",
        ),
      ).toMatchObject({ amount: 648700, paymentDate: "2026-11-18" }));
    it("still OCRs a scanned PDF whose only text layer is an unrelated footer", async () =>
      expect(
        await recognize(
          await imagePdf(textImage(receipt), true),
          "application/pdf",
          "receipt",
        ),
      ).toMatchObject({ amount: 648700, paymentDate: "2026-11-18" }));
    it("leaves a blank image empty", async () =>
      expect(await recognize(textImage([""]), "image/png", "identity")).toEqual(
        {},
      ));
    it("allows error handling for an unreadable image", async () => {
      await expect(
        recognize(Buffer.from("bad-image"), "image/png", "identity"),
      ).rejects.toThrow();
    });
  },
);
