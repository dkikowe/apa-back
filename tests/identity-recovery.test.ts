import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const engine = vi.hoisted(() => ({
  recognize: vi.fn(),
  setParameters: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock("tesseract.js", async (original) => ({
  ...(await original<typeof import("tesseract.js")>()),
  createWorker: vi.fn(async () => engine),
}));
import { recognize } from "../server/services/ocr.js";
import { missingDocumentFields } from "../shared/document-recognition.js";
import { printedBirthDate } from "../server/services/document-fields.js";
import { textPdf } from "./ocr-fixtures.js";
const core = [
  "SURNAME: TEST",
  "GIVEN NAMES: PERSON",
  "DATE OF BIRTH: 15.04.1975",
  "IIN: 000123456789",
];
const details = [
  "DOCUMENT NUMBER: 123456789",
  "ISSUED BY: TEST AUTHORITY",
  "DATE OF ISSUE: 01.01.2020",
  "DATE OF EXPIRY: 01.01.2030",
];
const response = (lines: string[]) => ({
  data: { text: lines.join("\n"), blocks: [] },
});
const image = () =>
  sharp({
    create: { width: 100, height: 100, channels: 3, background: "pink" },
  })
    .png()
    .toBuffer();
beforeEach(() => {
  vi.clearAllMocks();
  engine.recognize.mockReset();
  engine.recognize.mockResolvedValue(response([]));
  engine.terminate.mockResolvedValue(undefined);
});
describe("Automatic identity recovery", () => {
  it("continues after names/IIN until issuer, number and validity are recovered, retaining prior values", async () => {
    engine.recognize
      .mockResolvedValueOnce(response([...core, "PATRONYMIC: -"]))
      .mockResolvedValueOnce(response([details[0], "SURNAME: INCORRECT"]))
      .mockResolvedValueOnce(response(details.slice(1)));
    const fields = await recognize(await image(), "image/png", "identity");
    expect(fields).toMatchObject({
      iin: "000123456789",
      lastNameLatin: "TEST",
      middleName: "",
      documentNumber: "123456789",
      issuedBy: "TEST AUTHORITY",
      issueDate: "2020-01-01",
      expiryDate: "2030-01-01",
    });
    expect(engine.recognize).toHaveBeenCalledTimes(3);
    expect(missingDocumentFields("identity", fields)).toEqual([]);
    expect(engine.terminate).toHaveBeenCalled();
  });
  it("automatically recovers IIN on a later pass and changes pixels/layout", async () => {
    engine.recognize
      .mockResolvedValueOnce(response([...core.slice(0, 3), ...details]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([core[3]]));
    expect((await recognize(await image(), "image/png", "identity")).iin).toBe(
      "000123456789",
    );
    expect(engine.recognize).toHaveBeenCalledTimes(3);
    expect(engine.setParameters.mock.calls[0]).not.toEqual(
      engine.setParameters.mock.calls[1],
    );
    expect(
      engine.recognize.mock.calls[0][0].equals(
        engine.recognize.mock.calls[2][0],
      ),
    ).toBe(false);
  });
  it("does not endlessly retry a missing side or invent fields", async () => {
    engine.recognize.mockResolvedValue(response(core));
    const fields = await recognize(await image(), "image/png", "identity");
    expect(engine.recognize).toHaveBeenCalledTimes(9);
    expect(fields.issuedBy).toBeUndefined();
    expect(fields.middleName).toBeUndefined();
    expect(missingDocumentFields("identity", fields)).toContain("кім берді");
  });
  it("recreates a failed engine and retains the successfully read fields", async () => {
    engine.recognize
      .mockResolvedValueOnce(response(core))
      .mockRejectedValueOnce(new Error("temporary OCR failure"))
      .mockResolvedValueOnce(response(details));
    expect(
      (await recognize(await image(), "image/png", "identity")).issuedBy,
    ).toBe("TEST AUTHORITY");
    expect(engine.terminate).toHaveBeenCalledTimes(2);
  });
  it("does not choose between conflicting IIN readings", async () => {
    engine.recognize
      .mockResolvedValueOnce(response(core))
      .mockResolvedValue(response([...details, "IIN: 999123456789"]));
    expect(
      (await recognize(await image(), "image/png", "identity")).iin,
    ).toBeUndefined();
  });
  it("reads missing secondary fields in a PDF with a complete native IIN/name", async () => {
    engine.recognize.mockResolvedValue(response(details));
    const fields = await recognize(
      textPdf(core),
      "application/pdf",
      "identity",
    );
    expect(fields.issuedBy).toBe("TEST AUTHORITY");
    expect(fields.iin).toBe("000123456789");
    expect(engine.recognize).toHaveBeenCalledTimes(1);
  });
  it("recovers a printed birth date split from its IIN across PDF layers after the heading is lost", async () => {
    engine.recognize.mockResolvedValue(response(["IIN: 750415400001"]));
    const fields = await recognize(
      textPdf([
        "SURNAME: TEST",
        "GIVEN NAMES: PERSON",
        "15. 04. 1975",
        ...details,
      ]),
      "application/pdf",
      "identity",
    );
    expect(fields.birthDate).toBe("1975-04-15");
  });
  it("does not infer a date from IIN alone, a validity date, or conflicting printed centuries", () => {
    const fields = { iin: "750415400001" };
    for (const evidence of [
      "",
      "DATE OF ISSUE\n15.04.1975",
      "15.04.1975\n—\n15.04.1985",
      "15.04.1875\n15.04.1975",
      "16.04.1975",
    ])
      expect(printedBirthDate([evidence], fields)).toBeUndefined();
    expect(
      printedBirthDate(["15.04.1975"], { ...fields, issueDate: "1975-04-15" }),
    ).toBeUndefined();
  });
  it("skips OCR for a complete native PDF without requiring a patronymic", async () => {
    const fields = await recognize(
      textPdf([...core, ...details]),
      "application/pdf",
      "identity",
    );
    expect(missingDocumentFields("identity", fields)).toEqual([]);
    expect(engine.recognize).not.toHaveBeenCalled();
  });
});

it("re-reads a receipt PDF for a missing payer and time while retaining the printed amount and number", async () => {
  engine.recognize
    .mockResolvedValueOnce(response(["DATE: 18.11.2026 12:55"]))
    .mockResolvedValueOnce(response(["Оплачено с Kaspi Gold"]))
    .mockResolvedValueOnce(response(["ФИО покупателя Тест А."]));
  const fields = await recognize(
    textPdf([
      "TOTAL: 6,487.00 KZT",
      "DATE: 18.11.2026",
      "RECIPIENT: TEST ORGANIZATION",
      "RECEIPT NUMBER: TEST-100",
    ]),
    "application/pdf",
    "receipt",
  );
  expect(fields).toMatchObject({
    amount: 648700,
    receiptNumber: "TEST-100",
    paymentTime: "12:55",
    method: "с Kaspi Gold",
    payerName: "Тест А.",
  });
  expect(engine.recognize).toHaveBeenCalledTimes(3);
});

it("enlarges a missing labeled receipt row and reads it without overwriting native fields", async () => {
  const pdf = textPdf([
    "TOTAL: 1600 KZT",
    "DATE: 26.11.2026 17:16",
    "RECEIPT NUMBER: TEST-100",
    "SENDER: TEST A.",
    "PAYMENT METHOD: TEST CARD",
    "RECIPIENT:",
  ]);
  engine.recognize
    .mockResolvedValueOnce(response([]))
    .mockResolvedValueOnce(response([]))
    .mockResolvedValueOnce(response(["RECIPIENT: SAMPLE B.", "TOTAL: 1 KZT"]));
  expect(await recognize(pdf, "application/pdf", "receipt")).toMatchObject({
    amount: 160000,
    recipientName: "SAMPLE B.",
    method: "TEST CARD",
  });
  expect(engine.recognize).toHaveBeenCalledTimes(3);
  const full = await sharp(engine.recognize.mock.calls[0][0]).metadata();
  const crop = await sharp(engine.recognize.mock.calls[2][0]).metadata();
  expect(crop.height).toBeLessThan(full.height / 2);
});

describe("later OCR strategies", () => {
  it("recovers Cyrillic names even when their Latin spellings are already complete", async () => {
    const previousFields = {
      lastNameLatin: "TEST",
      firstNameLatin: "PERSON",
      iin: "000123456789",
      birthDate: "1975-04-15",
      documentNumber: "123456789",
      issuedBy: "СЫНАҚ ОРГАНЫ",
      issueDate: "2020-01-01",
      expiryDate: "2030-01-01",
    };
    expect(missingDocumentFields("identity", previousFields)).toEqual([
      "тегі",
      "аты",
    ]);
    expect(
      missingDocumentFields("identity", {
        ...previousFields,
        issuedBy: "TEST AUTHORITY",
        lastName: "СЫНАҚ",
      }),
    ).toEqual(["аты"]);
    engine.recognize
      .mockResolvedValueOnce(response(["SURNAME: TEST", "ТЕГІ: СЫНАҚ"]))
      .mockResolvedValueOnce(response(["GIVEN NAMES: PERSON", "АТЫ: ҮЛГІ"]));
    const fields = await recognize(await image(), "image/png", "identity", {
      recoveryStage: 1,
      previousFields,
    });
    expect(fields).toMatchObject({
      ...previousFields,
      lastName: "СЫНАҚ",
      firstName: "ҮЛГІ",
    });
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(missingDocumentFields("identity", fields)).toEqual([]);
  });
  it("recovers a missing receipt field in a new rendering while keeping verified values", async () => {
    const previousFields = {
      amount: 160000,
      paymentDate: "2026-11-26",
      paymentTime: "17:16",
      payerName: "TEST A.",
      recipientName: "SAMPLE B.",
      receiptNumber: "TEST-100",
    };
    engine.recognize.mockResolvedValueOnce(
      response(["PAYMENT METHOD: TEST CARD", "TOTAL: 9 KZT"]),
    );
    const f = await recognize(await image(), "image/png", "receipt", {
      recoveryStage: 1,
      previousFields,
    });
    expect(f).toMatchObject({ ...previousFields, method: "TEST CARD" });
    expect(engine.recognize).toHaveBeenCalledTimes(1);
    expect(engine.setParameters.mock.calls[0][0]).toMatchObject({
      thresholding_method: "2",
    });
  });
  it("retains explicit blank patronymic and withholds an IIN disagreement across recovery jobs", async () => {
    const previousFields = {
      lastNameLatin: "TEST",
      firstNameLatin: "PERSON",
      birthDate: "1975-04-15",
      middleName: "",
      iin: "000123456789",
    };
    const conflicts: string[] = [];
    engine.recognize.mockResolvedValue(
      response(["IIN: 999123456789", "PATRONYMIC: INCORRECT", ...details]),
    );
    const f = await recognize(await image(), "image/png", "identity", {
      recoveryStage: 1,
      previousFields,
      conflicts,
    });
    expect(f).toMatchObject({
      issuedBy: "TEST AUTHORITY",
      middleName: "",
      documentNumber: "123456789",
    });
    expect(f.iin).toBeUndefined();
    expect(conflicts).toContain("iin");
    const final = await recognize(await image(), "image/png", "identity", {
      recoveryStage: 2,
      previousFields: f,
      conflicts,
    });
    expect(final.iin).toBeUndefined();
  });
  it.each([
    ["QR123456789", "QR123456789"],
    ["QR123456780", undefined],
    ["08123456789", "08123456789"],
  ])(
    "reads the mixed-script receipt number from its own pixels (%s)",
    async (token, expected) => {
      const line = "Түбіртек Мо 08123456789";
      const bbox = { x0: 12, y0: 12, x1: 85, y1: 24 };
      engine.recognize
        .mockResolvedValueOnce({
          data: {
            text: line,
            blocks: [
              {
                paragraphs: [
                  {
                    lines: [
                      {
                        text: line,
                        bbox,
                        words: [{ text: "08123456789", bbox }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        })
        .mockResolvedValueOnce(response([token!]));
      const fields = await recognize(await image(), "image/png", "receipt");
      expect(fields.receiptNumber).toBe(expected);
      expect(engine.setParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        }),
      );
    },
  );
  it("retains a receipt number conflict across jobs without losing other recovered fields", async () => {
    const conflicts: string[] = [];
    engine.recognize.mockResolvedValue(
      response(["RECEIPT NUMBER: TX-987", "PAYMENT METHOD: TEST CARD"]),
    );
    const f = await recognize(await image(), "image/png", "receipt", {
      recoveryStage: 1,
      previousFields: { receiptNumber: "TX-123", amount: 900 },
      conflicts,
    });
    expect(f).toMatchObject({ method: "TEST CARD", amount: 900 });
    expect(f.receiptNumber).toBeUndefined();
    expect(conflicts).toContain("receiptNumber");
    expect(
      (
        await recognize(await image(), "image/png", "receipt", {
          recoveryStage: 2,
          previousFields: f,
          conflicts,
        })
      ).receiptNumber,
    ).toBeUndefined();
  });
});
