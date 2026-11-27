import { beforeEach, expect, it, vi } from "vitest";
import { textPdf } from "./ocr-fixtures.js";
import { recognize } from "../server/services/ocr.js";
import { missingDocumentFields } from "../shared/document-recognition.js";

const reads = vi.hoisted(() => ({ page: vi.fn(), crop: vi.fn() }));
vi.mock("tesseract.js", async (original) => ({
  ...(await original<typeof import("tesseract.js")>()),
  createWorker: async (languages: string | string[]) => ({
    recognize: languages === "eng" ? reads.crop : reads.page,
    setParameters: async () => {},
    terminate: async () => {},
  }),
}));

const number = "QA2786241";
const lines = [
  "SYNTHETIC RECEIPT",
  "TOTAL: 1234.00 KZT",
  "DATE: 18.11.2026",
  "RECIPIENT: DEMO ORGANIZATION",
  "PAYER: DEMO PERSON",
  "PAYMENT METHOD: TEST CARD",
  "RECEIPT NUMBER: " + number,
];
const result = (text: string) => ({ data: { text, blocks: [] } });

beforeEach(() => {
  reads.page.mockReset().mockResolvedValue(result("RECEIPT NUMBER: Q42786241"));
  reads.crop.mockReset().mockResolvedValue(result(number));
});

it("resolves a newly disputed single printed number while payment time is absent", async () => {
  const conflicts: string[] = [];
  const fields = await recognize(textPdf(lines), "application/pdf", "receipt", {
    conflicts,
  });
  expect(fields.receiptNumber).toBe(number);
  expect(missingDocumentFields("receipt", fields)).toEqual(["уақыт"]);
  expect(conflicts).toEqual([]);
  expect(reads.crop).toHaveBeenCalledTimes(2);
});

it.each([
  [number, "QA2786242"],
  ["QA2786242", "QA2786242"],
])(
  "withholds the number when the visible token readings are %s and %s",
  async (first, second) => {
    reads.crop
      .mockResolvedValueOnce(result(first))
      .mockResolvedValue(result(second));
    const conflicts = ["receiptNumber"];
    const fields = await recognize(
      textPdf(lines),
      "application/pdf",
      "receipt",
      { conflicts, recoveryStage: 3 },
    );
    expect(fields.receiptNumber).toBeUndefined();
    expect(fields.paymentTime).toBeUndefined();
    expect(conflicts).toEqual(["receiptNumber"]);
  },
);

it("does not use a single crop to resolve two printed numbers", async () => {
  const conflicts = ["receiptNumber"];
  for (const bytes of [
    textPdf([...lines, "RECEIPT NUMBER: QA2786242"]),
    textPdf(lines, lines),
  ]) {
    const fields = await recognize(bytes, "application/pdf", "receipt", {
      conflicts,
      recoveryStage: 3,
    });
    expect(fields.receiptNumber).toBeUndefined();
    expect(conflicts).toEqual(["receiptNumber"]);
  }
  expect(reads.crop).not.toHaveBeenCalled();
});
