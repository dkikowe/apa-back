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
