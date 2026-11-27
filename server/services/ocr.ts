import { InvalidDocumentError, WrongDocumentKindError } from "./ocr-policy.js";
export { WrongDocumentKindError } from "./ocr-policy.js";
import { createWorker, PSM } from "tesseract.js";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { invalidIdentityFields } from "../../shared/domain.js";
import { missingDocumentFields } from "../../shared/document-recognition.js";
import {
  addCitizenCardEvidence,
  extractFields,
  extractIdentityLayout,
  hasBlankIdentityMrz,
  identityIinCandidates,
  printedBirthDate,
  receiptHeadingFields,
  isReceiptInsteadOfIdentity,
  isIdentityInsteadOfReceipt,
  type PositionedText,
} from "./document-fields.js";
export {
  extractFields,
  extractIdentityLayout,
  receiptAmount,
  type PositionedText,
} from "./document-fields.js";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
// PDF content streams can list the left column before the right column. Rebuild
// receipt rows by their visible position, so dates stay beside their labels.
export function receiptTextLines(items: PositionedText[]) {
  return receiptRows(items)
    .map((row) => row.text)
    .join("\n");
}

// Tesseract may return the value before its label when their baselines differ
// by a few pixels. Group overlapping text on the same printed row.
function receiptRows(items: PositionedText[]): PositionedText[] {
  const rows: PositionedText[][] = [];
  for (const item of [...items]
    .filter((v) => v.text.trim())
    .sort((a, b) => a.bbox.y1 - b.bbox.y1 || a.bbox.x0 - b.bbox.x0)) {
    const row = rows.at(-1);
    const anchor = row?.[0]?.bbox;
    const box = item.bbox;
    const overlap = anchor
      ? Math.min(box.y1, anchor.y1) - Math.max(box.y0, anchor.y0)
      : 0;
    if (
      anchor &&
      (Math.abs(anchor.y1 - box.y1) <= 2 ||
        overlap > 0.6 * Math.min(box.y1 - box.y0, anchor.y1 - anchor.y0))
    )
      row!.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => ({
    text: row
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)
      .map((v) => v.text.trim())
      .join(" "),
    bbox: {
      x0: Math.min(...row.map((v) => v.bbox.x0)),
      x1: Math.max(...row.map((v) => v.bbox.x1)),
      y0: Math.min(...row.map((v) => v.bbox.y0)),
      y1: Math.max(...row.map((v) => v.bbox.y1)),
    },
  }));
}

// Read a narrow strip with its printed heading, stopping before the next
// heading. Kaspi prints the amount and recipient together in the success header.
function receiptBands(items: PositionedText[], height: number) {
  const rows = receiptRows(items).map((row) => {
    const success =
      /^(?:Сәтті аударылды|Перевод выполнен успешно|Оплата совершена|Төлем жасалды)/iu.test(
        row.text,
      );
    const keys = success
      ? ["amount", "recipientName"]
      : receiptHeadingFields(row.text);
    const boundary =
      keys.length > 0 ||
      /^(?:Аударым түрі|Тип перевода|Комиссия|Сообщение|Адрес|ИИН|БИН)(?=\s|:|$)/iu.test(
        row.text,
      );
    return { ...row, keys, boundary, success };
  });
  return rows.flatMap((row, i) => {
    if (!row.keys.length) return [];
    const lineHeight = Math.max(8, row.bbox.y1 - row.bbox.y0);
    const top = Math.max(0, Math.floor(row.bbox.y0 - lineHeight * 0.3));
    const next = rows.slice(i + 1).find((v) => v.boundary)?.bbox.y0 ?? height;
    const bottom = Math.min(
      height,
      Math.floor(next),
      Math.ceil(row.bbox.y1 + lineHeight * (row.success ? 10 : 4)),
    );
    return bottom > top ? [{ top, height: bottom - top, keys: row.keys }] : [];
  });
}
// Locate only the printed recipient, including a value on the same line as
// its label. Identical lines in multiple positions are ambiguous.
function recipientBox(lines: Tesseract.Line[], name: string) {
  const boxes = lines.flatMap((line) => {
    const text = line.text.trim().replace(/\s+/gu, " ");
    if (text === name) return [line.bbox];
    if (
      !receiptHeadingFields(text).includes("recipientName") ||
      !text.endsWith(" " + name)
    )
      return [];
    const words = line.words?.slice(-name.split(" ").length);
    if (!words?.length || words.map((w) => w.text).join(" ") !== name)
      return [];
    return [
      {
        x0: words[0].bbox.x0,
        x1: words.at(-1)!.bbox.x1,
        y0: Math.min(...words.map((w) => w.bbox.y0)),
        y1: Math.max(...words.map((w) => w.bbox.y1)),
      },
    ];
  });
  return boxes.length === 1 ? boxes[0] : undefined;
}
const foldRecipientU = (name: string) =>
  name.replace(/[үұ]/gu, "у").replace(/[ҮҰ]/gu, "У");

type Fields = Record<string, string | number>;
const hasDemographics = (fields: Fields) =>
  Boolean(fields.sex && fields.citizenship && fields.birthplace);
// A printed start/end pair supplies stronger evidence than one previously
// recognized endpoint. Keep all other accepted readings, including an
// explicitly absent patronymic, across pages and recovery rounds.
function mergeIdentityFields(fields: Fields, found: Fields) {
  if (
    found.issueDate &&
    found.expiryDate &&
    (!fields.issueDate || !fields.expiryDate)
  ) {
    fields.issueDate = found.issueDate;
    fields.expiryDate = found.expiryDate;
  }
  for (const [key, value] of Object.entries(found))
    if (fields[key] === undefined) fields[key] = value;
  for (const key of invalidIdentityFields(fields)) delete fields[key];
  return fields;
}
type RecoveryOptions = {
  recoveryStage?: number;
  previousFields?: Fields;
  // Worker persists unresolved identity/receipt number disagreements between rounds.
  conflicts?: string[];
};

type RecoveryPass = {
  render: () => Promise<Buffer>;
  mode: PSM;
  aligned: boolean;
};
function recoveryPasses(image: Buffer, stage: number): RecoveryPass[] {
  const gray = () =>
    sharp(image).flatten({ background: "white" }).grayscale().normalize();
  if (stage === 1) {
    // Larger native render plus local binarization (configured in Tesseract)
    // helps small text against uneven paper. Try slight tilt both ways.
    return [
      {
        render: () => gray().median(3).png().toBuffer(),
        mode: PSM.SPARSE_TEXT,
        aligned: true,
      },
      {
        render: () => gray().sharpen().png().toBuffer(),
        mode: PSM.SINGLE_BLOCK,
        aligned: true,
      },
      ...[-3, 3].map((angle) => ({
        render: () =>
          gray().rotate(angle, { background: "white" }).png().toBuffer(),
        mode: PSM.AUTO,
        aligned: false,
      })),
    ];
  }
  if (stage === 2) {
    // The earlier reader covered landscape rotation but not an upside-down scan.
    // Individual color channels can separate blue/green security printing from ink.
    return [
      {
        render: () =>
          sharp(image)
            .toColourspace("srgb")
            .extractChannel("red")
            .normalize()
            .png()
            .toBuffer(),
        mode: PSM.SPARSE_TEXT,
        aligned: true,
      },
      {
        render: () =>
          sharp(image)
            .toColourspace("srgb")
            .extractChannel("blue")
            .normalize()
            .png()
            .toBuffer(),
        mode: PSM.AUTO,
        aligned: true,
      },
      {
        render: () => gray().rotate(180).png().toBuffer(),
        mode: PSM.SPARSE_TEXT,
        aligned: false,
      },
      {
        render: () => gray().rotate(180).sharpen().png().toBuffer(),
        mode: PSM.AUTO,
        aligned: false,
      },
    ];
  }
  // Revisit small print by changing orientation, lighting correction and
  // segmentation independently. Only compare PDF anchors in their own frame.
  const group = (stage - 3) % 3;
  const cycle = Math.floor((stage - 3) / 3);
  const variant = cycle % 4;
  if (group === 0) {
    const angle = [0, 2, -2, 4][variant];
    return [90, 270, 180, 0].map((rotation, i) => ({
      render: () =>
        // Bank receipts can print a white success title on a coloured panel.
        // Preserve colour for the layout engine when correcting orientation.
        sharp(image)
          .flatten({ background: "white" })
          .rotate(rotation + angle, { background: "white" })
          .png()
          .toBuffer(),
      mode: (i + cycle) % 2 ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT,
      aligned: rotation === 0 && angle === 0,
    }));
  }
  if (group === 1) {
    const tile = [64, 48, 96, 32][variant];
    return [
      {
        render: () =>
          gray()
            .clahe({ width: tile, height: tile, maxSlope: 4 })
            .sharpen()
            .png()
            .toBuffer(),
        mode: PSM.SPARSE_TEXT,
        aligned: true,
      },
      {
        // Light text on a dark screenshot or oversaturated security background.
        render: () =>
          gray().negate({ alpha: false }).normalize().png().toBuffer(),
        mode: PSM.AUTO,
        aligned: true,
      },
      {
        render: () =>
          gray()
            .linear(1.4, -[48, 36, 24, 60][variant])
            .sharpen()
            .png()
            .toBuffer(),
        mode: PSM.SINGLE_BLOCK,
        aligned: true,
      },
    ];
  }
  // Overlapping strips preserve a heading and its value together while
  // making small characters readable without enlarging the entire page.
  const offsets = variant % 2 ? [1, 0.5, 0] : [0, 0.5, 1];
  return offsets.map((offset) => ({
    render: async () => {
      const { width, height } = await sharp(image).metadata();
      const stripHeight = Math.max(
        1,
        Math.ceil(height * (0.44 + 0.03 * variant)),
      );
      return gray()
        .extract({
          left: 0,
          top: Math.round((height - stripHeight) * offset),
          width,
          height: stripHeight,
        })
        .resize({ width: 2800, height: 1800, fit: "inside" })
        .sharpen()
        .png()
        .toBuffer();
    },
    mode: cycle % 2 ? PSM.SPARSE_TEXT : PSM.AUTO,
    aligned: false,
  }));
}

// Only a perfectly uniform white or black sheet positively proves the absence
// of print. Faint content and incomplete sides remain eligible for recovery.
async function emptySheet(image: Buffer) {
  const input = sharp(image, { limitInputPixels: 25_000_000 });
  const flattened = (await input.metadata()).hasAlpha
    ? sharp(await input.flatten({ background: "white" }).png().toBuffer())
    : input;
  const { channels } = await flattened.stats();
  const colour = channels.slice(0, 3);
  return colour.every((c) => c.min === 255) || colour.every((c) => c.max === 0);
}

// Dispute resolution is stricter than field extraction. Accept one explicit
// heading only and read the number at that heading, never an unrelated code.
function singleLabelledNumber(text: string, kind: string) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const idHeading = /^(?:ЖСН|ИИН|IIN)(?=[:/\s]|$)/iu;
  const headings = lines.flatMap((line, index) =>
    (
      kind === "identity"
        ? idHeading.test(line)
        : receiptHeadingFields(line).includes("receiptNumber")
    )
      ? [index]
      : [],
  );
  if (headings.length !== 1) return;
  const index = headings[0];
  const block = lines.slice(index, index + 2).join("\n");
  if (kind === "identity") {
    const printed = identityIinCandidates(block);
    const all = identityIinCandidates(text);
    if (printed.length === 1 && all.length === 1 && all[0] === printed[0])
      return printed[0];
    return;
  }
  const number = extractFields(block, "receipt").receiptNumber;
  return typeof number === "string" && /\d/.test(number) ? number : undefined;
}

// Locate the unique printed value next to the native label. PDF.js may
// combine the whole line into one text item or keep the number in its own
// item. Font measurements only guide the crop; the value must match pixels.
function labelledReceiptBox(items: PositionedText[], number: string) {
  const rows = receiptRows(items);
  const indices = rows.flatMap((r, i) =>
    receiptHeadingFields(r.text).includes("receiptNumber") ? [i] : [],
  );
  if (indices.length !== 1) return;
  const i = indices[0];
  const row = rows[i].text.endsWith(number)
    ? rows[i]
    : rows[i + 1]?.text === number
      ? rows[i + 1]
      : undefined;
  if (!row) return;
  const matches = items.filter(
    ({ text, bbox }) =>
      text.trimEnd().endsWith(number) &&
      bbox.y1 > row.bbox.y0 &&
      bbox.y0 < row.bbox.y1 &&
      bbox.x0 >= row.bbox.x0 - 1 &&
      bbox.x1 <= row.bbox.x1 + 1,
  );
  if (matches.length !== 1) return;
  const { text, bbox } = matches[0];
  const line = text.trimEnd();
  if (line === number) return bbox;
  const split = line.length - number.length;
  if (!/[\s:№#]/u.test(line[split - 1])) return;
  const ctx = createCanvas(1, 1).getContext("2d");
  ctx.font = "20px sans-serif";
  const fraction =
    ctx.measureText(line.slice(0, split)).width / ctx.measureText(line).width;
  if (!(fraction > 0 && fraction < 1)) return;
  return { ...bbox, x0: bbox.x0 + fraction * (bbox.x1 - bbox.x0) };
}

function qrPrefixMisread(value: string, qr: string) {
  const digits = qr.slice(2);
  return (
    value.endsWith(digits) &&
    /^(?:[0OQ(][()0285BR]{0,2})?$/i.test(value.slice(0, -digits.length))
  );
}

export async function recognize(
  buffer: Buffer,
  mime: string,
  kind: string,
  options: RecoveryOptions = {},
) {
  const stage = options.recoveryStage ?? 0;
  const previous = { ...options.previousFields };
  if (kind === "identity") {
    for (const key of invalidIdentityFields(previous)) delete previous[key];
  }
  const conflicts = options.conflicts ?? [];
  const numberKey = kind === "identity" ? "iin" : "receiptNumber";
  let resolvedNumber: string | undefined;
  const receiptNumbers = new Set<string>();
  function observeReceiptNumber(value: unknown) {
    if (typeof value === "string" && value.trim())
      receiptNumbers.add(value.replace(/\s/g, "").toUpperCase());
  }
  observeReceiptNumber(previous.receiptNumber);

  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let latinWorker: typeof worker;
  const workerOptions = {
    langPath: process.env.OCR_LANG_PATH || ".local/tessdata",
    cacheMethod: "none" as const,
    gzip: true,
    logger: () => {},
    errorHandler: () => {},
  };
  const getLatinWorker = async () =>
    (latinWorker ??= await createWorker("eng", 1, workerOptions));
  const recoveredLatinKeys = new Set<string>();
  let recoveredLatinIin: string | undefined;
  const scan = async (
    image: Buffer,
    mode = PSM.SPARSE_TEXT,
    blocks = kind === "identity",
  ) => {
    worker ??= await createWorker(
      (
        process.env.OCR_LANGUAGES ||
        (stage % 3 === 2 ? "eng+rus+kaz" : "kaz+rus+eng")
      ).split("+"),
      1,
      workerOptions,
    );
    await worker.setParameters({
      // Sparse mode keeps transfer label/value pairs in reading order instead
      // of concatenating the entire left column before the right column.
      tessedit_pageseg_mode: mode,
      ...(stage === 1 || (stage >= 3 && stage % 3 === 1)
        ? { thresholding_method: "2", user_defined_dpi: "300" }
        : {}),
    });
    return (await worker.recognize(image, {}, { text: true, blocks })).data;
  };
  // Kazakhstan's printed MRZ has a surname and given names separated by
  // double chevrons. Coloured security patterns after the padding can look
  // like letters. Only read the two name groups before a long padding run.
  const confirmMrzNames = async (image: Buffer, box: Tesseract.Bbox) => {
    const { x0, x1, y0, y1 } = box;
    const meta = await sharp(image).metadata();
    const left = Math.max(0, Math.floor(x0) - 15),
      top = Math.max(0, Math.floor(y0) - 12);
    const width = Math.min(meta.width - left, Math.ceil(x1) + 15 - left);
    const height = Math.min(meta.height - top, Math.ceil(y1) + 12 - top);
    if (width <= 0 || height <= 0) return;
    const crop = await sharp(image)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    const latin = await getLatinWorker();
    let first: { lastNameLatin: string; firstNameLatin: string } | undefined;
    for (const [h, mode] of [
      // Too much enlargement can turn chevrons into L or E. Read compact
      // lettering at a smaller scale before trying an enlarged fallback.
      [60, PSM.SINGLE_LINE],
      [44, PSM.SINGLE_BLOCK],
      [78, PSM.SINGLE_BLOCK],
    ] as const) {
      const strip = await sharp(crop)
        .resize({ width: 3000, height: h, fit: "inside" })
        .grayscale()
        .normalize()
        .extend({
          top: 15,
          bottom: 15,
          left: 15,
          right: 15,
          background: "white",
        })
        .png()
        .toBuffer();
      await latin.setParameters({
        tessedit_pageseg_mode: mode,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ<-'",
      });
      const text = (await latin.recognize(strip)).data.text.trim();
      if (text.includes("\n")) continue;
      const names = text
        .replace(/\s/g, "")
        .match(/^([A-Z]+(?:[-'<][A-Z]+)*)<<([A-Z]+(?:[-'<][A-Z]+)*)<{6,}/);
      if (!names) continue;
      const current = {
        lastNameLatin: names[1].replaceAll("<", " "),
        firstNameLatin: names[2].replaceAll("<", " "),
      };
      if (first) {
        if (
          current.lastNameLatin === first.lastNameLatin &&
          current.firstNameLatin === first.firstNameLatin
        )
          return current;
        return;
      }
      first = current;
    }
  };
  const confirmPrintedToken = async (
    rendered: Buffer,
    box: PositionedText["bbox"] | undefined,
    number: string,
    digitsOnly = false,
  ) => {
    if (!box || !/^[A-Z0-9][A-Z0-9./_-]*$/i.test(number)) return false;
    const { width, height } = await sharp(rendered).metadata();
    // Leave space for font metric differences and descenders in the source.
    const margin = Math.ceil((box.y1 - box.y0) * (digitsOnly ? 0.08 : 0.22));
    const left = Math.max(0, Math.floor(box.x0) - margin);
    const top = Math.max(0, Math.floor(box.y0) - margin);
    const right = Math.min(width, Math.ceil(box.x1) + margin);
    const bottom = Math.min(height, Math.ceil(box.y1) + margin);
    if (right <= left || bottom <= top) return false;
    const token = await sharp(rendered)
      .extract({ left, top, width: right - left, height: bottom - top })
      .png()
      .toBuffer();
    const latin = await getLatinWorker();
    const reads: [number, PSM][] = [
      [58, PSM.SINGLE_LINE],
      [78, PSM.SINGLE_WORD],
    ];
    if (digitsOnly) reads.push([92, PSM.SINGLE_BLOCK]);
    let matches = 0;
    for (const [h, mode] of reads) {
      const pixels = sharp(token)
        .resize({ height: h, width: 3000, fit: "inside" })
        .grayscale()
        .normalize();
      if (mode === PSM.SINGLE_WORD) pixels.sharpen();
      const strip = await pixels
        .extend({
          top: 14,
          bottom: 14,
          left: 16,
          right: 16,
          background: "white",
        })
        .png()
        .toBuffer();
      await latin.setParameters({
        tessedit_pageseg_mode: mode,
        tessedit_char_whitelist: digitsOnly
          ? "0123456789"
          : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/.:#",
      });
      const read = (await latin.recognize(strip)).data.text
        .trim()
        .replace(/^[:#]\s*/, "");
      // A split glyph can produce 13 digits. Try another segmentation,
      // but a different complete 12-digit reading remains a conflict.
      if (digitsOnly && !/^\d{12}$/.test(read)) continue;
      if (read.toUpperCase() !== number.toUpperCase()) return false;
      if (++matches === 2) return true;
    }
    return false;
  };
  // Some digital IDs print the headings into the page background. The number
  // is native text, but a full-page OCR pass can misread one of its digits.
  const confirmInlineIin = async (image: Buffer, values: PositionedText[]) => {
    const tokens = values.filter((item) => /^\d{12}$/.test(item.text.trim()));
    const text = values.map((v) => v.text.trim()).join("\n");
    if (
      tokens.length !== 1 ||
      [...text.matchAll(/(?<!\d)\d(?:[ \t]*\d){11}(?![ \t]*\d)/g)].length !==
        1 ||
      values.filter((v) => /^\d{9}$/.test(v.text.trim())).length !== 1
    )
      return;
    const { bbox } = tokens[0];
    const number = tokens[0].text.trim();
    if (!printedBirthDate([text], { iin: number })) return;
    const h = bbox.y1 - bbox.y0;
    const left = Math.max(0, Math.floor(bbox.x0 - 5.5 * h));
    const top = Math.max(0, Math.floor(bbox.y0));
    const meta = await sharp(image).metadata();
    const right = Math.min(meta.width, Math.floor(bbox.x0) - 2);
    const bottom = Math.min(meta.height, Math.ceil(bbox.y1 + h * 0.1));
    if (right <= left || bottom <= top) return;
    const label = await sharp(image)
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize({ height: 72 })
      .grayscale()
      .normalize()
      .extend({ top: 14, bottom: 14, left: 16, right: 16, background: "white" })
      .png()
      .toBuffer();
    const printedLabel = (
      await scan(label, PSM.SINGLE_LINE, false)
    ).text.trim();
    const labels = printedLabel.split(/\s*[/|]\s*/);
    if (
      labels.length > 2 ||
      !labels.some((part) => /^(?:ЖСН|ИИН|IIN)$/iu.test(part)) ||
      !labels.every((part) =>
        /^(?:ЖСН|ИИН|IIN|[ИIІНH]{2}[ИНNHН])$/iu.test(part),
      )
    )
      return;
    if (await confirmPrintedToken(image, bbox, number, true)) return number;
  };
  const confirmRecipient = async (
    rendered: Buffer,
    box: Tesseract.Bbox,
    name: string,
  ) => {
    try {
      const crop = await sharp(rendered)
        .extract({
          left: box.x0,
          top: box.y0,
          width: box.x1 - box.x0,
          height: box.y1 - box.y0,
        })
        .png()
        .toBuffer();
      let first: string | undefined;
      for (const [height, mode] of [
        [42, PSM.SINGLE_LINE],
        [64, PSM.SINGLE_BLOCK],
      ] as const) {
        const strip = sharp(crop)
          .resize({ height, width: 3000, fit: "inside" })
          .grayscale()
          .normalize();
        if (mode === PSM.SINGLE_BLOCK) strip.sharpen();
        const enlarged = await strip
          .extend({
            top: 18,
            bottom: 18,
            left: 23,
            right: 23,
            background: "white",
          })
          .png()
          .toBuffer();
        const text = (await scan(enlarged, mode, false)).text
          .trim()
          .replace(/\s+/gu, " ");
        if (
          foldRecipientU(text) !== foldRecipientU(name) ||
          (first && text !== first)
        )
          return;
        first = text;
      }
      return first;
    } catch {
      // A failed optional crop leaves the full-page reading available.
      return;
    }
  };
  const scanReceipt = async (
    image: Buffer,
    seed: Record<string, string | number> = {},
    positioned: PositionedText[] = [],
  ) => {
    const fields = { ...seed, ...previous };
    const { width, height } = await sharp(image).metadata();
    // Scope visually verified QR codes to this page: another page may carry
    // a different receipt, which must still trigger conflict detection.
    const printedQr = new Set<string>();
    const gray = () => sharp(image).grayscale().normalize();
    const section = (bottom: boolean) => {
      const cropHeight = Math.ceil(height * 0.65);
      return gray()
        .extract({
          left: 0,
          top: bottom ? height - cropHeight : 0,
          width,
          height: cropHeight,
        })
        .resize({ width: 2600, height: 3000, fit: "inside" })
        .sharpen()
        .png()
        .toBuffer();
    };
    const passes = [
      { render: async () => image, mode: PSM.SPARSE_TEXT },
      { render: async () => image, mode: PSM.AUTO },
      {
        render: () => gray().sharpen().png().toBuffer(),
        mode: PSM.SPARSE_TEXT,
      },
      {
        render: () =>
          gray().clahe({ width: 32, height: 32, maxSlope: 3 }).png().toBuffer(),
        mode: PSM.AUTO,
      },
      { render: () => section(true), mode: PSM.SPARSE_TEXT },
      { render: () => section(false), mode: PSM.SPARSE_TEXT },
      { render: () => gray().threshold(160).png().toBuffer(), mode: PSM.AUTO },
      { render: () => gray().rotate(90).png().toBuffer(), mode: PSM.AUTO },
      { render: () => gray().rotate(270).png().toBuffer(), mode: PSM.AUTO },
    ];
    type Pass = {
      render: () => Promise<Buffer>;
      mode: PSM;
      keys?: string[];
      collectRows?: boolean;
    };
    const queue: Pass[] = (stage ? recoveryPasses(image, stage) : passes).map(
      (pass, i) => ({
        ...pass,
        collectRows: i < 2,
      }),
    );
    let checkedRecipient = false;
    let bestBands = receiptBands(positioned, height);
    let bandImage = image;
    let bandWidth = width;
    let read = false;
    for (let i = 0; i < queue.length; i++) {
      if (
        read &&
        (Date.now() > recoveryDeadline ||
          !missingDocumentFields("receipt", fields).length)
      )
        break;
      const pass = queue[i];
      if (pass.keys && pass.keys.every((key) => fields[key] !== undefined))
        continue;
      try {
        const rendered = await pass.render();
        const result = await scan(rendered, pass.mode, !!pass.collectRows);
        if (pass.collectRows && isIdentityInsteadOfReceipt(result.text))
          throw new WrongDocumentKindError("receipt");
        read = true;
        const lines =
          result.blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)) ||
          [];
        const found = {
          ...extractFields(result.text, "receipt"),
          ...extractFields(receiptTextLines(lines), "receipt"),
        };
        // At receipt scale OCR can confuse у, ү and ұ. Only amend the OCR
        // spelling when two reads of that same name agree on every letter.
        const name = found.recipientName;
        if (
          !checkedRecipient &&
          !seed.recipientName &&
          found.receiptType === "personal" &&
          typeof name === "string" &&
          /[уүұ]/iu.test(name) &&
          (!fields.recipientName ||
            (typeof fields.recipientName === "string" &&
              foldRecipientU(fields.recipientName) === foldRecipientU(name)))
        ) {
          const box = recipientBox(lines, name);
          if (box && box.x1 > box.x0 && box.y1 > box.y0) {
            checkedRecipient = true;
            const confirmed = await confirmRecipient(rendered, box, name);
            if (confirmed) {
              fields.recipientName = confirmed;
              if (previous.recipientName) previous.recipientName = confirmed;
            }
          }
        }
        // In Cyrillic text Tesseract can read the letters in QR as 08 or 05.
        // Inspect the actual token pixels before accepting a numeric reading.
        for (const line of lines) {
          if (!receiptHeadingFields(line.text).includes("receiptNumber"))
            continue;
          const word = line.words?.at(-1);
          if (
            !word ||
            /^QR\d+$/i.test(word.text) ||
            !/^[0OQ(][()0285BR]{0,2}\d{6,39}$/i.test(word.text)
          )
            continue;
          const { x0, y0, x1, y1 } = word.bbox;
          if (x1 <= x0 || y1 <= y0) continue;
          const token = await sharp(rendered)
            .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
            .extend({
              top: 8,
              bottom: 8,
              left: 8,
              right: 8,
              background: "white",
            })
            .png()
            .toBuffer();
          await worker!.setParameters({
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          });
          let code: string;
          try {
            code = (await worker!.recognize(token)).data.text.trim();
          } finally {
            await worker!.setParameters({ tessedit_char_whitelist: "" });
          }
          if (/^QR\d{6,39}$/.test(code)) {
            if (qrPrefixMisread(word.text, code)) printedQr.add(code);
            else {
              observeReceiptNumber(code);
              observeReceiptNumber(word.text);
            }
          }
        }
        if (!pass.keys || pass.keys.includes("receiptNumber")) {
          const number = found.receiptNumber;
          const matched = [...printedQr].filter(
            (code) =>
              number === undefined || qrPrefixMisread(String(number), code),
          );
          if (matched.length === 1) found.receiptNumber = matched[0];
          for (const code of printedQr) observeReceiptNumber(code);
          observeReceiptNumber(found.receiptNumber);
        }
        for (const [key, value] of Object.entries(found))
          if (
            fields[key] === undefined &&
            (!pass.keys ||
              pass.keys.includes(key) ||
              (key === "receiptType" &&
                pass.keys.includes("recipientName") &&
                found.recipientName === fields.recipientName))
          )
            fields[key] = value;
        if (pass.collectRows && lines.length) {
          // OCR boxes belong to the actual buffer Tesseract saw. A rotated
          // page or enlarged strip has a different origin and dimensions.
          const frame = await sharp(rendered).metadata();
          const bands = receiptBands(lines, frame.height);
          if (bands.length > bestBands.length) {
            bestBands = bands;
            bandImage = rendered;
            bandWidth = frame.width;
          }
        }
      } catch (error) {
        if (error instanceof WrongDocumentKindError) throw error;
        await worker?.terminate().catch(() => {});
        worker = undefined;
        if (Date.now() > recoveryDeadline || pass === queue.at(-1)) {
          if (!read && !Object.keys(fields).length) throw error;
          break;
        }
      }
      if (i === 1) {
        // Try field-specific enlarged crops while there is still budget.
        // Deduplicate by missing field to bound work on repeated PDF headings.
        const targeted: Pass[] = [];
        const seen = new Set<string>();
        for (const band of bestBands) {
          const keys = band.keys.filter(
            (key) => fields[key] === undefined && !seen.has(key),
          );
          if (!keys.length) continue;
          for (const key of keys) seen.add(key);
          for (const mode of [PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT]) {
            targeted.push({
              mode,
              keys,
              render: () => {
                const strip = sharp(bandImage)
                  .grayscale()
                  .normalize()
                  .extract({
                    left: 0,
                    top: band.top,
                    width: bandWidth,
                    height: band.height,
                  })
                  .resize({
                    width: Math.min(3000, bandWidth * 2),
                    height: 1600,
                    fit: "inside",
                  });
                return (
                  mode === PSM.SINGLE_BLOCK
                    ? strip.sharpen()
                    : strip.threshold(165)
                )
                  .png()
                  .toBuffer();
              },
            });
          }
        }
        queue.splice(i + 1, 0, ...targeted);
      }
    }
    return { text: "", fields };
  };
  // Bound the work for unreadable/missing sides, rather than retrying the
  // same pixels forever and blocking every other document in the queue.
  const recoveryDeadline = Date.now() + 120_000;
  const scanIdentity = async (
    image: Buffer,
    seed: Record<string, string | number> = {},
    nativeValues: PositionedText[] = [],
    singlePage = true,
    inspectPrintedDetails = true,
  ) => {
    const fields = mergeIdentityFields({ ...previous }, seed);
    const confirmedIin = singlePage
      ? await confirmInlineIin(image, nativeValues).catch(() => undefined)
      : undefined;
    if (confirmedIin) {
      resolvedNumber = fields.iin = confirmedIin;
      if (
        !missingDocumentFields("identity", fields).length &&
        (hasDemographics(fields) || !inspectPrintedDetails)
      )
        return { text: "", fields };
    }
    const texts: string[] = [];
    const iins = new Set<string>();
    if (typeof seed.iin === "string") iins.add(seed.iin);
    if (typeof previous.iin === "string") iins.add(previous.iin);
    const printedIins = new Set<string>();
    if (typeof seed.iin === "string") printedIins.add(seed.iin);
    let triedMrz = false;
    let successfulPasses = 0;
    let lastError: unknown;
    const meta = await sharp(image).metadata();
    const width = meta.width!,
      height = meta.height!;
    const gray = () => sharp(image).grayscale().normalize();
    const region = (bottom: boolean) => {
      const cropHeight = Math.ceil(height * 0.65);
      return gray()
        .extract({
          left: 0,
          top: bottom ? height - cropHeight : 0,
          width,
          height: cropHeight,
        })
        .resize({ width: 3000, height: 3000, fit: "inside" })
        .sharpen()
        .png()
        .toBuffer();
    };
    // Different layouts, local contrast and enlarged overlapping regions
    // recover small/faded text. Coordinate-based PDF matching is used only
    // on passes that retain the original coordinate system.
    const passes = [
      { image: async () => image, mode: PSM.SPARSE_TEXT, positioned: true },
      { image: async () => image, mode: PSM.AUTO, positioned: true },
      {
        image: () => gray().sharpen().png().toBuffer(),
        mode: PSM.SPARSE_TEXT,
        positioned: true,
      },
      {
        image: () =>
          gray().clahe({ width: 32, height: 32, maxSlope: 3 }).png().toBuffer(),
        mode: PSM.AUTO,
        positioned: true,
      },
      { image: () => region(false), mode: PSM.SPARSE_TEXT, positioned: false },
      { image: () => region(true), mode: PSM.SPARSE_TEXT, positioned: false },
      {
        image: () => gray().threshold(160).png().toBuffer(),
        mode: PSM.AUTO,
        positioned: true,
      },
      {
        image: () => sharp(image).rotate(90).png().toBuffer(),
        mode: PSM.AUTO,
        positioned: false,
      },
      {
        image: () => sharp(image).rotate(270).png().toBuffer(),
        mode: PSM.AUTO,
        positioned: false,
      },
    ];
    const queue = stage
      ? recoveryPasses(image, stage).map((pass) => ({
          image: pass.render,
          mode: pass.mode,
          positioned: pass.aligned,
        }))
      : passes;
    for (const pass of queue) {
      if (
        successfulPasses &&
        ((!missingDocumentFields("identity", fields).length &&
          (fields.identityMrz !== "blank" ||
            hasDemographics(fields) ||
            successfulPasses >= 2)) ||
          Date.now() > recoveryDeadline)
      )
        break;
      try {
        const rendered = await pass.image();
        const result = await scan(rendered, pass.mode);
        if (isReceiptInsteadOfIdentity(result.text))
          throw new WrongDocumentKindError();
        successfulPasses++;
        texts.push(result.text);
        const anchors =
          result.blocks?.flatMap((block) =>
            block.paragraphs.flatMap((paragraph) => paragraph.lines),
          ) || [];
        const found = {
          ...extractFields(result.text, "identity"),
          ...(pass.positioned
            ? extractIdentityLayout(nativeValues, anchors)
            : {}),
        };
        for (const value of identityIinCandidates(result.text)) {
          iins.add(value);
          printedIins.add(value);
        }
        if (typeof found.iin === "string") iins.add(found.iin);
        // A faded IIN heading can be lost while all twelve digits survive.
        // Corroborate a checkpoint only when its independently read card
        // number also matches this page. This cannot create a new IIN.
        if (
          typeof previous.iin === "string" &&
          /^\d{12}$/.test(previous.iin) &&
          typeof found.documentNumber === "string" &&
          found.documentNumber === previous.documentNumber
        ) {
          const printed = new Set(
            Array.from(
              result.text.matchAll(/(?<!\d)\d(?:[ \t]*\d){11}(?![ \t]*\d)/g),
              (m) => m[0].replace(/[ \t]/g, ""),
            ),
          );
          if (printed.size === 1 && printed.has(previous.iin))
            printedIins.add(previous.iin);
        }
        mergeIdentityFields(fields, found);
        if (hasBlankIdentityMrz(result.text)) fields.identityMrz = "blank";
        if (iins.size > 1 && !conflicts.includes("iin")) conflicts.push("iin");
        delete fields.iin;
        if (confirmedIin) fields.iin = confirmedIin;
        else if (iins.size === 1 && !conflicts.includes("iin"))
          fields.iin = [...iins][0];
        if (
          stage > 0 &&
          singlePage &&
          !triedMrz &&
          typeof fields.iin === "string" &&
          printedIins.size === 1 &&
          printedIins.has(fields.iin) &&
          (!fields.firstNameLatin || !fields.lastNameLatin) &&
          fields.identityMrz !== "blank" &&
          Date.now() < recoveryDeadline
        ) {
          const rows = anchors.filter(({ text }) => {
            // The multilingual pass can confuse 5/S or 1/I. Use its text only
            // to locate the strip. The English reads determine both names.
            const row = text
              .replace(/\s/g, "")
              .match(
                /^([\p{L}\d]+(?:[-'<][\p{L}\d]+)*)<<([\p{L}\d]+(?:[-'<][\p{L}\d]+)*)<{4,}/u,
              );
            return row && /\p{L}/u.test(row[1]) && /\p{L}/u.test(row[2]);
          });
          if (rows.length === 1) {
            triedMrz = true;
            // Contrast enhancement locates the line, but may remove thin
            // character strokes. Use original pixels whenever coordinates align.
            const names = await confirmMrzNames(
              pass.positioned ? image : rendered,
              rows[0].bbox,
            );
            if (
              names &&
              (!fields.firstNameLatin ||
                fields.firstNameLatin === names.firstNameLatin) &&
              (!fields.lastNameLatin ||
                fields.lastNameLatin === names.lastNameLatin)
            ) {
              recoveredLatinIin = fields.iin;
              for (const [key, value] of Object.entries(names)) {
                if (!fields[key]) {
                  fields[key] = value;
                  recoveredLatinKeys.add(key);
                }
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof WrongDocumentKindError) throw error;
        lastError = error;
        // A failed OCR engine can be recreated on the next strategy.
        await worker?.terminate().catch(() => {});
        worker = undefined;
        if (Date.now() > recoveryDeadline) break;
      }
    }
    if (!successfulPasses && !Object.keys(seed).length)
      throw lastError || new Error("OCR_FAILED");
    return { text: texts.join("\n"), fields };
  };
  try {
    let text = "";
    const nativeFields: Record<string, string | number> = {};
    const identitySources: string[] = [];
    if (mime === "application/pdf") {
      const { getDocument, OPS } =
        await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pdf = await getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
      }).promise.catch((error: unknown) => {
        if (
          error instanceof Error &&
          /^(InvalidPDFException|PasswordException)$/.test(error.name)
        )
          throw new InvalidDocumentError();
        throw error;
      });
      try {
        let identityPageInReceipt = false;
        let blankPages = 0;
        if (pdf.numPages > 10) throw new InvalidDocumentError();
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const content = await page.getTextContent();
          let layer = "";
          for (const item of content.items) {
            if ("str" in item) layer += item.str + (item.hasEOL ? "\n" : " ");
          }
          const streamText = layer;
          if (kind === "receipt" && page.rotate === 0) {
            layer = receiptTextLines(
              content.items.flatMap((item) =>
                "str" in item &&
                item.transform[1] === 0 &&
                item.transform[2] === 0
                  ? [
                      {
                        text: item.str,
                        bbox: {
                          x0: item.transform[4],
                          x1: item.transform[4] + item.width,
                          y0: -item.transform[5] - item.height,
                          y1: -item.transform[5],
                        },
                      },
                    ]
                  : [],
              ),
            );
          }
          if (
            kind === "receipt" &&
            isIdentityInsteadOfReceipt(layer + "\n" + streamText)
          ) {
            identityPageInReceipt = true;
            continue;
          }
          if (kind === "identity") {
            if (isReceiptInsteadOfIdentity(layer))
              throw new WrongDocumentKindError();
            identitySources.push(layer);
          }
          const layerFields = {
            ...(kind === "receipt" ? extractFields(streamText, kind) : {}),
            ...extractFields(layer, kind),
          };
          if (kind === "identity" && hasBlankIdentityMrz(layer))
            layerFields.identityMrz = "blank";
          if (kind === "receipt")
            observeReceiptNumber(layerFields.receiptNumber);
          const layerComplete =
            missingDocumentFields(
              kind === "identity" ? "identity" : "receipt",
              layerFields,
            ).length === 0;
          const completeLayer =
            layer.replace(/\s/g, "").length > 40 && layerComplete;
          const nativeNumber =
            pdf.numPages === 1 ? singleLabelledNumber(layer, kind) : undefined;
          const receiptCandidate =
            kind === "receipt" &&
            nativeNumber &&
            singleLabelledNumber(streamText, kind) === nativeNumber &&
            nativeNumber === layerFields.receiptNumber
              ? nativeNumber
              : undefined;
          const candidate =
            completeLayer && conflicts.includes(numberKey)
              ? kind === "receipt"
                ? receiptCandidate
                : nativeNumber
              : undefined;
          // A hybrid ID can have all mandatory values as native text while
          // the labels for sex, birthplace or citizenship are printed pixels.
          const hasUnscannedLabels =
            kind === "identity" &&
            !hasDemographics({ ...previous, ...layerFields }) &&
            (await page.getOperatorList()).fnArray.some((op: number) =>
              [
                OPS.paintImageXObject,
                OPS.paintInlineImageXObject,
                OPS.paintImageMaskXObject,
              ].includes(op),
            );
          if (completeLayer && !candidate && !hasUnscannedLabels) {
            text += layer + "\n";
            Object.assign(nativeFields, layerFields);
            continue;
          }
          const baseScale = kind === "identity" ? 3 : 2;
          const base = page.getViewport({ scale: baseScale });
          // Oversized paper coordinates need a smaller raster, even on the
          // first pass. Keep an explicit margin for rounding canvas edges.
          const extraDetail = stage
            ? Math.max(
                1,
                Math.min(
                  stage === 1 ? 1.6 : 1.2,
                  Math.sqrt(12_000_000 / (base.width * base.height)),
                ),
              )
            : 1;
          const ratio = Math.min(
            extraDetail,
            8192 / Math.max(base.width, base.height),
            Math.sqrt(24_000_000 / (base.width * base.height)),
          );
          if (!Number.isFinite(ratio) || ratio <= 0)
            throw new InvalidDocumentError();
          const viewport = page.getViewport({ scale: baseScale * ratio });
          const canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          await page.render({
            canvas: canvas as any,
            canvasContext: canvas.getContext("2d") as any,
            viewport,
          }).promise;
          const rendered = canvas.toBuffer("image/png");
          if (candidate && candidate === layerFields[numberKey]) {
            // A complete digital original and two visual reads must independently
            // agree before overriding any earlier identifier disagreement.
            if (
              singleLabelledNumber(
                (await scan(rendered, PSM.SPARSE_TEXT, false)).text,
                kind,
              ) === candidate &&
              Date.now() < recoveryDeadline
            ) {
              const enhanced = await sharp(rendered)
                .grayscale()
                .normalize()
                .sharpen()
                .png()
                .toBuffer();
              if (
                singleLabelledNumber(
                  (await scan(enhanced, PSM.AUTO, false)).text,
                  kind,
                ) === candidate
              )
                resolvedNumber = candidate;
            }
            if (!hasUnscannedLabels && (resolvedNumber || kind !== "receipt")) {
              text += layer + "\n";
              Object.assign(nativeFields, layerFields);
              continue;
            }
          }
          if (!streamText.trim() && (await emptySheet(rendered))) {
            blankPages++;
            continue;
          }
          const values: PositionedText[] = content.items.flatMap((item) => {
            if (
              !("str" in item) ||
              !item.str.trim() ||
              item.transform[1] !== 0 ||
              item.transform[2] !== 0 ||
              page.rotate !== 0
            )
              return [];
            const [x, y] = viewport.convertToViewportPoint(
              item.transform[4],
              item.transform[5],
            );
            return [
              {
                text: item.str,
                bbox: {
                  x0: x,
                  y0: y - item.height * viewport.scale,
                  x1: x + item.width * viewport.scale,
                  y1: y,
                },
              },
            ];
          });
          // On an incomplete receipt, full-page OCR can introduce a spurious
          // number even when the native layer has one clearly labelled value.
          // Confirm it on the original row independently of any missing time.
          const confirmNativeReceipt = async () => {
            if (
              receiptCandidate &&
              (conflicts.includes("receiptNumber") || receiptNumbers.size > 1)
            ) {
              if (
                await confirmPrintedToken(
                  rendered,
                  labelledReceiptBox(values, receiptCandidate),
                  receiptCandidate,
                ).catch(() => false)
              )
                resolvedNumber = receiptCandidate;
            }
          };
          if (completeLayer && candidate && kind === "receipt") {
            await confirmNativeReceipt();
            text += layer + "\n";
            Object.assign(nativeFields, layerFields);
            continue;
          }
          let scanned;
          try {
            scanned =
              kind === "receipt"
                ? await scanReceipt(rendered, layerFields, values)
                : await scanIdentity(
                    rendered,
                    layerFields,
                    values,
                    pdf.numPages === 1,
                    hasUnscannedLabels,
                  );
          } catch (error) {
            if (error instanceof WrongDocumentKindError) {
              if (kind !== "receipt") throw error;
              identityPageInReceipt = true;
              continue;
            }
            const usableLayer =
              kind === "identity"
                ? Object.keys(layerFields).length > 0
                : layerFields.amount !== undefined && !!layerFields.paymentDate;
            if (!usableLayer) throw error;
            text += layer + "\n";
            Object.assign(nativeFields, layerFields);
            continue;
          }
          if (kind === "receipt") await confirmNativeReceipt();
          text += scanned.text + "\n";
          if (kind === "receipt")
            Object.assign(
              nativeFields,
              "fields" in scanned ? scanned.fields : {},
              layerFields,
            );
          if (kind === "identity") {
            identitySources.push(scanned.text);
            Object.assign(nativeFields, scanned.fields);
          }
        }
        if (blankPages === pdf.numPages) throw new InvalidDocumentError();
        if (
          identityPageInReceipt &&
          !(
            nativeFields.amount &&
            (nativeFields.receiptNumber ||
              nativeFields.method ||
              nativeFields.recipientName ||
              nativeFields.payerName)
          )
        )
          throw new WrongDocumentKindError("receipt");
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else {
      const prepared = sharp(buffer, { limitInputPixels: 25000000 })
        .rotate()
        .resize(
          stage === 1
            ? { width: 3200, height: 3800, fit: "inside" }
            : { width: 2400, height: 3200, fit: "inside" },
        );

      const image = await prepared
        .png()
        .toBuffer()
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /unsupported image format|corrupt|pixel limit|invalid.*header|premature end|unexpected end|end of stream|incomplete (?:image|buffer)/i.test(
              error.message,
            )
          )
            throw new InvalidDocumentError();
          throw error;
        });
      if ((await emptySheet(image)) && (await emptySheet(buffer)))
        throw new InvalidDocumentError();
      if (kind === "receipt") {
        const original = stage
          ? image
          : await sharp(image).grayscale().normalize().png().toBuffer();
        const scanned = await scanReceipt(original);
        text = scanned.text;
        Object.assign(nativeFields, scanned.fields);
      } else {
        const scanned = await scanIdentity(image);
        text = scanned.text;
        identitySources.push(text);
        Object.assign(nativeFields, scanned.fields);
      }
    }
    const result =
      kind === "identity"
        ? mergeIdentityFields({ ...previous }, nativeFields)
        : { ...extractFields(text, kind), ...nativeFields, ...previous };
    if (kind === "identity") {
      addCitizenCardEvidence(result, identitySources.join("\n"));
      const candidates = new Set(
        identityIinCandidates(identitySources.join("\n")),
      );
      if (typeof result.iin === "string") candidates.add(result.iin);
      delete result.iin;
      if (candidates.size > 1 && !conflicts.includes("iin"))
        conflicts.push("iin");
      if (candidates.size === 1 && !conflicts.includes("iin")) {
        result.iin = [...candidates][0];
        if (!result.birthDate) {
          const date = printedBirthDate(identitySources, result);
          if (date) result.birthDate = date;
        }
      }
    }
    if (kind === "receipt") {
      if (receiptNumbers.size > 1 && !conflicts.includes("receiptNumber"))
        conflicts.push("receiptNumber");
      if (conflicts.includes("receiptNumber")) delete result.receiptNumber;
    }
    if (resolvedNumber) {
      result[numberKey] = resolvedNumber;
      const index = conflicts.indexOf(numberKey);
      if (index >= 0) conflicts.splice(index, 1);
    }
    if (recoveredLatinIin && result.iin !== recoveredLatinIin)
      for (const key of recoveredLatinKeys) delete result[key];
    return result;
  } finally {
    await Promise.all([worker?.terminate(), latinWorker?.terminate()]);
  }
}
