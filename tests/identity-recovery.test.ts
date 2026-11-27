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
import {
  extractFields,
  extractIdentityLayout,
  printedBirthDate,
} from "../server/services/document-fields.js";
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

describe("issuer and validity on identity cards", () => {
  const period = { issueDate: "2020-01-02", expiryDate: "2030-01-01" };
  const interval = "02.01.2020 — 01.01.2030";
  it.each([
    "Жарамдылық мерзімі",
    "Жарамдылык мерзими / Срок действия",
    "Жарамдылықмерзiмi",
    "БЕРІЛГЕН КҮНІ — ҚОЛДАНЫЛУ МЕРЗІМІ/ДАТА ВЫДАЧИ — СРОК ДЕЙСТВИЯ",
  ])(
    "reads the printed interval separately from the authority under %s",
    (label) => {
      const rows = [
        "БЕРГЕН ОРГАН / ОРГАН ВЫДАЧИ",
        label,
        "02.01.2020",
        "—",
        "01.01.2030",
      ];
      expect(extractFields(rows.join("\n"), "identity")).toEqual(period);
      rows.push("КЕМ ВЫДАН", "ҚР ІІМ");
      expect(extractFields(rows.join("\n"), "identity")).toEqual({
        ...period,
        issuedBy: "ҚР ІІМ",
      });
    },
  );
  it("never assigns a lone date under a combined field, a missing endpoint, or a reversed range", () => {
    const label = "DATE OF ISSUE / DATE OF EXPIRY";
    for (const lines of [
      [label, "02.01.2020"],
      [label, "—", "02.01.2020"],
      [label, "02.01.2020 —"],
      [label, "01.01.2030 — 02.01.2020"],
      ["БЕРІЛГЕН КҮНІ", "СРОК ДЕЙСТВИЯ", "02.01.2020"],
      ["ДАТА ВЫДАЧИ: 01.01.2030", "СРОК ДЕЙСТВИЯ: 02.01.2020"],
    ])
      expect(extractFields(lines.join("\n"), "identity")).toEqual({});
    expect(
      extractFields([label, "02.01.2020", "01.01.2030"].join("\n"), "identity"),
    ).toEqual(period);
  });
  it("does not let a nearby native PDF date range fill an issuing-authority column", () => {
    const at = (text: string, x: number, y: number) => ({
      text,
      bbox: { x0: x, x1: x + 90, y0: y, y1: y + 10 },
    });
    const values = [at(interval, 100, 125), at("МВД РК", 350, 125)];
    expect(extractIdentityLayout(values, [at("КЕМ ВЫДАН", 100, 105)])).toEqual(
      {},
    );
    expect(
      extractIdentityLayout(values, [
        at("Жарамдылык мерзими", 100, 105),
        at("КЕМ ВЫДАН", 350, 105),
      ]),
    ).toEqual({ ...period, issuedBy: "МВД РК" });
    expect(extractFields("ISSUED BY\n" + interval, "identity")).toEqual({});
  });
  it("replaces an invalid checkpoint issuer and a lone earlier date with the verified printed values", async () => {
    const previousFields = {
      lastNameLatin: "TEST",
      firstNameLatin: "PERSON",
      birthDate: "1975-04-15",
      iin: "000123456789",
      documentNumber: "123456789",
      issuedBy: interval,
      expiryDate: period.issueDate,
    };
    engine.recognize.mockResolvedValueOnce(response(["ISSUED BY", interval]));
    engine.recognize.mockResolvedValueOnce(
      response([
        "ISSUED BY: TEST AUTHORITY",
        "DATE OF ISSUE / DATE OF EXPIRY",
        interval,
      ]),
    );
    const result = await recognize(await image(), "image/png", "identity", {
      recoveryStage: 1,
      previousFields,
    });
    expect(result).toMatchObject({
      ...previousFields,
      issuedBy: "TEST AUTHORITY",
      ...period,
    });
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(previousFields.issuedBy).toBe(interval);
  });
});

describe("later OCR strategies", () => {
  it.each([
    ["Үлгі Ұ.", "Үлгі Ұ.", "Үлгі Ұ."],
    ["Үлгі Ұ.", "Улгі У.", "Улгі У."],
    ["Үлгі Ұ.", "Басқа А.", "Улгі У."],
  ])(
    "uses consistent recipient glyph readings and retains the baseline on disagreement (%s, %s)",
    async (first, second, expected) => {
      const name = "Улгі У.";
      const baseline = response([
        "TOTAL: 2000 KZT",
        "DATE: 14.11.2026 18:45",
        "RECIPIENT: " + name,
        "SENDER: Тест А.",
        "RECEIPT NUMBER: TEST-123",
        "PAYMENT METHOD: TEST CARD",
      ]);
      engine.recognize
        .mockResolvedValueOnce({
          data: {
            ...baseline.data,
            blocks: [
              {
                paragraphs: [
                  {
                    lines: [
                      { text: name, bbox: { x0: 10, y0: 10, x1: 60, y1: 26 } },
                    ],
                  },
                ],
              },
            ],
          },
        })
        .mockResolvedValueOnce(response([first]))
        .mockResolvedValueOnce(response([second]));
      const fields = await recognize(await image(), "image/png", "receipt");
      expect(fields.recipientName).toBe(expected);
      expect(fields.payerName).toBe("Тест А.");
      expect(engine.recognize).toHaveBeenCalledTimes(3);
    },
  );

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

describe("continued recovery from the original file", () => {
  const printedReceipt = {
    amount: 500000,
    paymentDate: "2026-11-20",
    paymentTime: "12:34",
    receiptNumber: "TEST-500",
    payerName: "TEST PERSON",
    recipientName: "TEST ORGANIZATION",
  };
  const markedPage = () =>
    sharp({
      create: { width: 320, height: 120, channels: 3, background: "#ffffff" },
    })
      .composite([
        {
          input: {
            create: {
              width: 36,
              height: 120,
              channels: 3,
              background: "#000000",
            },
          },
          left: 242,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

  it("uses the rotated frame for a labelled strip below the original image height", async () => {
    const heading = "PAYMENT METHOD";
    const lines = [
      { text: heading, bbox: { x0: 12, y0: 1900, x1: 400, y1: 1922 } },
    ];
    let sawPrintedStrip = false;
    engine.recognize.mockImplementation(async (input: Buffer) => {
      const meta = await sharp(input).metadata();
      if (meta.height! > meta.width!)
        return {
          data: { text: heading, blocks: [{ paragraphs: [{ lines }] }] },
        };
      const { channels } = await sharp(input).stats();
      if (meta.width! > meta.height! * 6 && channels[0].mean < 5) {
        sawPrintedStrip = true;
        return response(["PAYMENT METHOD: TEST CARD"]);
      }
      return response([]);
    });
    const fields = await recognize(await markedPage(), "image/png", "receipt", {
      previousFields: printedReceipt,
      recoveryStage: 3,
    });
    expect(sawPrintedStrip).toBe(true);
    expect(fields).toMatchObject({ ...printedReceipt, method: "TEST CARD" });
  });
  it("changes the actual pixels and geometry after earlier recovery stages", async () => {
    const sample = await sharp(await markedPage())
        .composite([
          {
            input: {
              create: {
                width: 40,
                height: 20,
                channels: 3,
                background: "#208130",
              },
            },
            left: 10,
            top: 8,
          },
        ])
        .png()
        .toBuffer(),
      frames: Buffer[] = [];
    engine.recognize.mockImplementation(async (input: Buffer) => {
      frames.push(input);
      return response(["PAYMENT METHOD: TEST CARD"]);
    });
    for (const stage of [2, 3, 4, 5, 6]) {
      expect(
        await recognize(sample, "image/png", "receipt", {
          recoveryStage: stage,
          previousFields: printedReceipt,
        }),
      ).toMatchObject({ method: "TEST CARD" });
    }
    expect(frames).toHaveLength(5);
    for (let i = 1; i < frames.length; i++)
      expect(frames[i].equals(frames[i - 1])).toBe(false);
    const shapes = await Promise.all(frames.map((f) => sharp(f).metadata()));
    expect(shapes[1].height).toBeGreaterThan(shapes[1].width!);
    const rotated = await sharp(frames[1]).stats();
    expect(rotated.channels[1].mean).toBeGreaterThan(rotated.channels[0].mean);
    expect(shapes[3].height).toBeLessThan(shapes[0].height!);
    expect(shapes[4].width).not.toBe(shapes[1].width);
  });
  it("identifies a broken file and a completely blank original while preserving faint print", async () => {
    const { InvalidDocumentError } =
      await import("../server/services/ocr-policy.js");
    const blank = await sharp({
      create: { width: 210, height: 320, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    for (const [file, mime] of [
      [blank, "image/png"],
      [Buffer.from("%PDF-1.7\nbroken"), "application/pdf"],
      [Buffer.from("not an image"), "image/png"],
    ] as const)
      await expect(recognize(file, mime, "identity")).rejects.toBeInstanceOf(
        InvalidDocumentError,
      );
    expect(engine.recognize).not.toHaveBeenCalled();
    const faint = await sharp(blank)
      .composite([
        {
          input: {
            create: {
              width: 20,
              height: 10,
              channels: 3,
              background: "#f4f4f4",
            },
          },
          left: 10,
          top: 10,
        },
      ])
      .png()
      .toBuffer();
    engine.recognize.mockResolvedValue(response(["PAYMENT METHOD: TEST CARD"]));
    expect(
      await recognize(faint, "image/png", "receipt", {
        previousFields: printedReceipt,
        recoveryStage: 4,
      }),
    ).toMatchObject({ method: "TEST CARD" });
  });
});

describe("identifier disputes in complete digital originals", () => {
  const receiptLines = [
    "TOTAL: 2000 KZT",
    "DATE: 14.11.2026 18:45",
    "RECIPIENT: EXAMPLE",
    "SENDER: TEST PERSON",
    "RECEIPT NUMBER: TX-1234",
    "PAYMENT METHOD: TEST CARD",
  ];
  it.each([
    [
      "identity",
      "iin",
      "000123456789",
      [...core, ...details],
      "IIN: 000123456789",
      "IIN: 000123456788",
    ],
    [
      "receipt",
      "receiptNumber",
      "TX-1234",
      receiptLines,
      "RECEIPT NUMBER: TX-1234",
      "RECEIPT NUMBER: TX-1235",
    ],
  ] as const)(
    "unlocks a %s number only with two matching labelled pixel readings",
    async (kind, key, value, source, heading, other) => {
      const pdf = textPdf([...source]),
        conflicts: string[] = [key];
      engine.recognize
        .mockResolvedValueOnce(response([heading]))
        .mockResolvedValueOnce(response([other]));
      expect(
        (
          await recognize(pdf, "application/pdf", kind, {
            conflicts,
            recoveryStage: 4,
          })
        )[key],
      ).toBeUndefined();
      expect(conflicts).toEqual([key]);
      engine.recognize.mockResolvedValue(response([heading]));
      expect(
        (
          await recognize(pdf, "application/pdf", kind, {
            conflicts,
            recoveryStage: 5,
          })
        )[key],
      ).toBe(value);
      expect(conflicts).toEqual([]);
      for (const doc of [
        textPdf([...source], [...source]),
        textPdf([...source, other]),
      ]) {
        const disputed: string[] = [key];
        expect(
          (
            await recognize(doc, "application/pdf", kind, {
              conflicts: disputed,
              recoveryStage: 6,
            })
          )[key],
        ).toBeUndefined();
        expect(disputed).toEqual([key]);
      }
    },
  );
});

it("scales a physically oversized PDF page into the safe raster budget", async () => {
  const file = textPdf(["SURNAME: TEST"]);
  // Equal-length replacement preserves PDF cross-reference offsets.
  const oversized = Buffer.from(
    file.toString("latin1").replace("[0 0 850 1000]", "[0 0 999 9999]"),
    "latin1",
  );
  const renders: number[][] = [];
  engine.recognize.mockImplementation(async (input: Buffer) => {
    const { width, height } = await sharp(input).metadata();
    renders.push([width, height]);
    return response([...core, ...details]);
  });
  for (const stage of [0, 1])
    expect(
      (
        await recognize(oversized, "application/pdf", "identity", {
          recoveryStage: stage,
        })
      ).documentNumber,
    ).toBe("123456789");
  expect(renders).toHaveLength(2);
  for (const [w, h] of renders) {
    expect(w * h).toBeLessThanOrEqual(25_000_000);
    expect(Math.max(w, h)).toBeLessThanOrEqual(8192);
  }
});
