import { OCR_LAST_ROUND, WrongDocumentKindError } from "./ocr-policy.js";
export { OCR_LAST_ROUND, WrongDocumentKindError } from "./ocr-policy.js";
import { createWorker, PSM } from "tesseract.js";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { missingDocumentFields } from "../../shared/document-recognition.js";
import {
  extractFields,
  extractIdentityLayout,
  identityIinCandidates,
  printedBirthDate,
  receiptHeadingFields,
  isReceiptInsteadOfIdentity,
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
type Fields = Record<string, string | number>;
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
  const previous = options.previousFields ?? {};
  const conflicts = options.conflicts ?? [];
  const receiptNumbers = new Set<string>();
  function observeReceiptNumber(value: unknown) {
    if (typeof value === "string" && value.trim())
      receiptNumbers.add(value.replace(/\s/g, "").toUpperCase());
  }
  observeReceiptNumber(previous.receiptNumber);

  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  const scan = async (
    image: Buffer,
    mode = PSM.SPARSE_TEXT,
    blocks = kind === "identity",
  ) => {
    worker ??= await createWorker(
      (
        process.env.OCR_LANGUAGES ||
        (stage === OCR_LAST_ROUND ? "eng+rus+kaz" : "kaz+rus+eng")
      ).split("+"),
      1,
      {
        langPath: process.env.OCR_LANG_PATH || ".local/tessdata",
        cacheMethod: "none",
        gzip: true,
        logger: () => {},
        errorHandler: () => {},
      },
    );
    await worker.setParameters({
      // Sparse mode keeps transfer label/value pairs in reading order instead
      // of concatenating the entire left column before the right column.
      tessedit_pageseg_mode: mode,
      ...(stage === 1
        ? { thresholding_method: "2", user_defined_dpi: "300" }
        : {}),
    });
    return (await worker.recognize(image, {}, { text: true, blocks })).data;
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
    let bestLines = positioned;
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
        read = true;
        const lines =
          result.blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)) ||
          [];
        const found = {
          ...extractFields(result.text, "receipt"),
          ...extractFields(receiptTextLines(lines), "receipt"),
        };
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
        if (
          pass.collectRows &&
          receiptBands(lines, height).length >
            receiptBands(bestLines, height).length
        )
          bestLines = lines;
      } catch (error) {
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
        for (const band of receiptBands(bestLines, height)) {
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
                const strip = gray()
                  .extract({
                    left: 0,
                    top: band.top,
                    width,
                    height: band.height,
                  })
                  .resize({
                    width: Math.min(3000, width * 2),
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
  ) => {
    const fields = { ...seed, ...previous };
    const texts: string[] = [];
    const iins = new Set<string>();
    if (typeof seed.iin === "string") iins.add(seed.iin);
    if (typeof previous.iin === "string") iins.add(previous.iin);
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
        (!missingDocumentFields("identity", fields).length ||
          Date.now() > recoveryDeadline)
      )
        break;
      try {
        const result = await scan(await pass.image(), pass.mode);
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
        for (const value of identityIinCandidates(result.text)) iins.add(value);
        if (typeof found.iin === "string") iins.add(found.iin);
        // Explicitly empty patronymics are meaningful. Never replace values
        // from a reliable PDF layer/earlier pass with later OCR guesses.
        for (const [key, value] of Object.entries(found))
          if (fields[key] === undefined) fields[key] = value;
        if (iins.size > 1 && !conflicts.includes("iin")) conflicts.push("iin");
        delete fields.iin;
        if (iins.size === 1 && !conflicts.includes("iin"))
          fields.iin = [...iins][0];
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
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const pdf = await getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
      }).promise;
      try {
        if (pdf.numPages > 10) throw new Error("PDF_PAGE_LIMIT");
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
          if (kind === "identity") {
            if (isReceiptInsteadOfIdentity(layer))
              throw new WrongDocumentKindError();
            identitySources.push(layer);
          }
          const layerFields = {
            ...(kind === "receipt" ? extractFields(streamText, kind) : {}),
            ...extractFields(layer, kind),
          };
          if (kind === "receipt")
            observeReceiptNumber(layerFields.receiptNumber);
          const layerComplete =
            missingDocumentFields(
              kind === "identity" ? "identity" : "receipt",
              layerFields,
            ).length === 0;
          if (layer.replace(/\s/g, "").length > 40 && layerComplete) {
            text += layer + "\n";
            Object.assign(nativeFields, layerFields);
            continue;
          }
          const baseScale = kind === "identity" ? 3 : 2;
          const base = page.getViewport({ scale: baseScale });
          // Preserve the original input limit. Recovery increases raster detail
          // only while there is headroom under the same pixel budget.
          const recoveryScale = Math.min(
            stage === 1 ? 1.6 : 1.2,
            Math.sqrt(12_000_000 / (base.width * base.height)),
          );
          const viewport = stage
            ? page.getViewport({
                scale: baseScale * Math.max(1, recoveryScale),
              })
            : base;
          if (viewport.width * viewport.height > 25000000)
            throw new Error("PDF_PAGE_LIMIT");
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
          let scanned;
          try {
            scanned =
              kind === "receipt"
                ? await scanReceipt(rendered, layerFields, values)
                : await scanIdentity(rendered, layerFields, values);
          } catch (error) {
            if (error instanceof WrongDocumentKindError) throw error;
            const usableLayer =
              kind === "identity"
                ? Object.keys(layerFields).length > 0
                : layerFields.amount !== undefined && !!layerFields.paymentDate;
            if (!usableLayer) throw error;
            text += layer + "\n";
            Object.assign(nativeFields, layerFields);
            continue;
          }
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
      if (kind === "receipt" && !stage) prepared.grayscale().normalize();
      const image = await prepared.png().toBuffer();
      if (kind === "receipt") {
        const scanned = await scanReceipt(image);
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
        ? nativeFields
        : { ...extractFields(text, kind), ...nativeFields };
    Object.assign(result, previous);
    if (kind === "identity") {
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
    return result;
  } finally {
    await worker?.terminate();
  }
}
