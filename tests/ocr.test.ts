import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { recognize, WrongDocumentKindError } from "../server/services/ocr.js";
import {
  textImage,
  textPdf,
  imagePdf,
  hybridIdentityPdf,
  mixedIdentityIinPdf,
} from "./ocr-fixtures.js";
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
  "IIN: 000123456789",
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
    it("does not merge conflicting IINs from a text layer", async () => {
      const fields = await recognize(
        textPdf([...identity, "IIN: 999123456789"]),
        "application/pdf",
        "identity",
      );
      expect(fields.iin).toBeUndefined();
    });
    it("reads a raster IIN even when native names and date are complete", async () => {
      expect(
        await recognize(
          await mixedIdentityIinPdf(),
          "application/pdf",
          "identity",
        ),
      ).toMatchObject({
        iin: "000123456789",
        lastNameLatin: "ULGIKYZY",
        firstNameLatin: "AIGUL",
        birthDate: "1975-04-15",
      });
    });
    it("reads an unlabelled IIN with faded title context in a photo", async () => {
      const photo = textImage([
        "Дата рождения",
        "15.04.1975",
        "000123456789",
        "000001KAZ7504150F3001010123456<0",
      ]);
      expect((await recognize(photo, "image/png", "identity")).iin).toBe(
        "000123456789",
      );
    });
    it("explains when a receipt is uploaded as an identity document", async () => {
      await expect(
        recognize(
          textImage([
            "Оплата совершена",
            "6 487 KZT",
            "№ чека QR123456789",
            "ИИН/БИН продавца 000123456789",
          ]),
          "image/png",
          "identity",
        ),
      ).rejects.toBeInstanceOf(WrongDocumentKindError);
    });
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
    it("reads a Kazakh receipt screenshot including number and payment source", async () => {
      const result = await recognize(
        textImage([
          "Төлем жасалды",
          "6 487 KZT",
          'ОО Ремесленников "URSHYK"',
          "Түбіртек № QR123456789",
          "Сатып алушының аты-жөні Сынақ А.",
          "Күні мен уақыты 06.08.2026 16:49",
          "Төленді Kaspi Gold",
        ]),
        "image/png",
        "receipt",
      );
      expect(result).toMatchObject({
        amount: 648700,
        receiptNumber: "QR123456789",
        paymentDate: "2026-08-06",
        paymentTime: "16:49",
        method: "Kaspi Gold",
        receiptType: "urshyk",
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
    it("combines raster field labels with native PDF values even when MRZ is already readable", async () => {
      expect(
        await recognize(
          await hybridIdentityPdf(),
          "application/pdf",
          "identity",
        ),
      ).toMatchObject({
        lastNameLatin: "ULGIKYZY",
        firstNameLatin: "AIGUL",
        birthDate: "1975-04-15",
      });
    });
    it("leaves an empty patronymic empty in a scanned identity PDF", async () => {
      const fields = await recognize(
        await imagePdf(
          textImage([
            "ЖЕКЕ КУӘЛІК / УДОСТОВЕРЕНИЕ ЛИЧНОСТИ",
            "ТЕГІ / ФАМИЛИЯ",
            "ҮЛГІҚЫЗЫ",
            "АТЫ / ИМЯ",
            "АЙГҮЛ",
            "ӘКЕСІНІҢ АТЫ / ОТЧЕСТВО",
            "",
            "УРАН КҮНІ / ДАТА РОЖДЕНИЯ",
            "15.04.1975",
            "ЖСН / ИИН: 000123456789",
          ]),
        ),
        "application/pdf",
        "identity",
      );
      expect(fields.middleName).toBe("");
      expect(fields.iin).toBe("000123456789");
    });
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
