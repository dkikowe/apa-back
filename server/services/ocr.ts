import { createWorker, PSM } from "tesseract.js";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { missingDocumentFields } from "../../shared/document-recognition.js";
import {
  extractFields,
  extractIdentityLayout,
  identityIinCandidates,
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
  const rows: { y: number; items: PositionedText[] }[] = [];
  for (const item of [...items]
    .filter((v) => v.text.trim())
    .sort((a, b) => a.bbox.y1 - b.bbox.y1 || a.bbox.x0 - b.bbox.x0)) {
    const row = rows.find((r) => Math.abs(r.y - item.bbox.y1) <= 2);
    if (row) row.items.push(item);
    else rows.push({ y: item.bbox.y1, items: [item] });
  }
  return rows
    .map((row) =>
      row.items
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)
        .map((v) => v.text)
        .join(" "),
    )
    .join("\n");
}
export class WrongDocumentKindError extends Error {
  constructor() {
    super(
      "Куәліктің орнына чек жүктелген. Жеке куәлікті таңдаңыз. Чекті «Төлем қосу» бөлімінде жүктеңіз.",
    );
    this.name = "WrongDocumentKindError";
  }
}
export async function recognize(buffer: Buffer, mime: string, kind: string) {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  const scan = async (image: Buffer, mode = PSM.SPARSE_TEXT) => {
    worker ??= await createWorker(
      (
        process.env.OCR_LANGUAGES ||
        (kind === "receipt" ? "eng+rus+kaz" : "kaz+rus+eng")
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
    });
    return (
      await worker.recognize(
        image,
        {},
        { text: true, blocks: kind === "identity" },
      )
    ).data;
  };
  const scanReceipt = async (
    image: Buffer,
    seed: Record<string, string | number> = {},
  ) => {
    const fields = { ...seed };
    const { width, height } = await sharp(image).metadata();
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
    let read = false;
    for (const pass of passes) {
      if (
        read &&
        (Date.now() > recoveryDeadline ||
          !missingDocumentFields("receipt", fields).length)
      )
        break;
      try {
        const result = await scan(await pass.render(), pass.mode);
        read = true;
        const found = extractFields(result.text, "receipt");
        for (const [key, value] of Object.entries(found))
          if (fields[key] === undefined) fields[key] = value;
      } catch (error) {
        await worker?.terminate().catch(() => {});
        worker = undefined;
        if (Date.now() > recoveryDeadline || pass === passes.at(-1)) {
          if (!read && !Object.keys(fields).length) throw error;
          break;
        }
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
    const fields = { ...seed };
    const texts: string[] = [];
    const iins = new Set<string>();
    if (typeof seed.iin === "string") iins.add(seed.iin);
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
    for (const pass of passes) {
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
        delete fields.iin;
        if (iins.size === 1) fields.iin = [...iins][0];
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
          const viewport = page.getViewport({
            scale: kind === "identity" ? 3 : 2,
          });
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
                ? await scanReceipt(rendered, layerFields)
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
        .resize({ width: 2400, height: 3200, fit: "inside" });
      if (kind === "receipt") prepared.grayscale().normalize();
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
    if (kind === "identity") {
      const candidates = new Set(
        identityIinCandidates(identitySources.join("\n")),
      );
      if (typeof result.iin === "string") candidates.add(result.iin);
      delete result.iin;
      if (candidates.size === 1) result.iin = [...candidates][0];
    }
    return result;
  } finally {
    await worker?.terminate();
  }
}
