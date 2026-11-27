import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { textPdf } from "./ocr-fixtures.js";
import { recognize } from "../server/services/ocr.js";

const reads = vi.hoisted(() => ({
  page: vi.fn(),
  label: vi.fn(),
  digits: vi.fn(),
}));
vi.mock("tesseract.js", async (original) => ({
  ...(await original<typeof import("tesseract.js")>()),
  createWorker: async (languages: string | string[]) => ({
    recognize: async (bytes: Buffer) => {
      const text =
        languages === "eng"
          ? reads.digits()
          : (await sharp(bytes).metadata()).height < 200
            ? reads.label()
            : reads.page();
      return { data: { text, blocks: [] } };
    },
    setParameters: async () => {},
    terminate: async () => {},
  }),
}));
const number = "750415300117";
const native = ["15.04.1975", number, "000000123"];
const previous = {
  birthDate: "1975-04-15",
  documentNumber: "000000123",
  issuedBy: "TEST AUTHORITY",
  firstName: "Сынақ",
  lastName: "Үлгі",
  middleName: "",
  firstNameLatin: "SYNAQ",
  lastNameLatin: "ULGI",
  issueDate: "2020-01-01",
  expiryDate: "2030-01-01",
};
beforeEach(() => {
  reads.page.mockReset().mockReturnValue("ИИН: 750415300118");
  reads.label.mockReset().mockReturnValue("ЖСН / ИИН");
  reads.digits.mockReset().mockReturnValue(number);
});
it.each([0, 8])(
  "recovers the inline PDF number at stage %i from its printed label and two digit reads",
  async (stage) => {
    const conflicts = stage ? ["iin"] : [];
    const fields = await recognize(
      textPdf(native),
      "application/pdf",
      "identity",
      {
        previousFields: previous,
        recoveryStage: stage,
        conflicts,
      },
    );
    expect(fields).toEqual({ ...previous, iin: number });
    expect(conflicts).toEqual([]);
    expect(reads.label).toHaveBeenCalledOnce();
    expect(reads.digits).toHaveBeenCalledTimes(2);
    expect(reads.page).not.toHaveBeenCalled();
  },
);
it.each(["ИИН / БИН", "unknown"])(
  "rejects an ambiguous or unrelated adjacent label %s",
  async (heading) => {
    reads.label.mockReturnValue(heading);
    const conflicts = ["iin"];
    const fields = await recognize(
      textPdf(native),
      "application/pdf",
      "identity",
      {
        previousFields: previous,
        recoveryStage: 8,
        conflicts,
      },
    );
    expect(fields.iin).toBeUndefined();
    expect(conflicts).toEqual(["iin"]);
    expect(reads.digits).not.toHaveBeenCalled();
  },
);
it("tries another segmentation after a split glyph while still requiring two exact reads", async () => {
  reads.digits
    .mockReturnValueOnce(number)
    .mockReturnValueOnce(number + "1")
    .mockReturnValue(number);
  const conflicts = ["iin"];
  const fields = await recognize(
    textPdf(native),
    "application/pdf",
    "identity",
    {
      previousFields: previous,
      recoveryStage: 8,
      conflicts,
    },
  );
  expect(fields.iin).toBe(number);
  expect(conflicts).toEqual([]);
  expect(reads.digits).toHaveBeenCalledTimes(3);
});
it("withholds a disputed IIN when just one crop matches the PDF", async () => {
  reads.digits.mockReturnValueOnce(number).mockReturnValue("750415300118");
  const conflicts = ["iin"];
  const fields = await recognize(
    textPdf(native),
    "application/pdf",
    "identity",
    {
      previousFields: previous,
      recoveryStage: 8,
      conflicts,
    },
  );
  expect(fields.iin).toBeUndefined();
  expect(conflicts).toEqual(["iin"]);
  expect(reads.digits).toHaveBeenCalledTimes(2);
});
it("does not resolve a dispute across several cards or without a matching printed birth date", async () => {
  for (const bytes of [
    textPdf(native, native),
    textPdf([...native, "IIN: 750415 300119"]),
    textPdf([...native, "000000124"]),
    textPdf(["16.04.1975", number, "000000123"]),
  ]) {
    const conflicts = ["iin"];
    const fields = await recognize(bytes, "application/pdf", "identity", {
      previousFields: previous,
      recoveryStage: 8,
      conflicts,
    });
    expect(fields.iin).toBeUndefined();
    expect(conflicts).toEqual(["iin"]);
  }
  expect(reads.digits).not.toHaveBeenCalled();
});
