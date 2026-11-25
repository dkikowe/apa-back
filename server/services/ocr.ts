import { createWorker, PSM } from "tesseract.js";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import {
  extractFields,
  extractIdentityLayout,
  identityDetails,
  machineReadableNames,
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
  const scanReceipt = async (image: Buffer) => {
    const first = await scan(image);
    const fields = extractFields(first.text, "receipt");
    if (
      [
        "amount",
        "paymentDate",
        "paymentTime",
        "receiptNumber",
        "recipientName",
        "method",
      ].some((key) => fields[key] === undefined)
    ) {
      // A second layout handles receipts whose labels and values form columns.
      // Keep the first pass's values; only fill fields it could not read.
      try {
        const second = await scan(image, PSM.AUTO);
        for (const [key, value] of Object.entries(
          extractFields(second.text, "receipt"),
        ))
          if (fields[key] === undefined) fields[key] = value;
      } catch {
        // A failed fallback must not discard fields already read successfully.
      }
    }
    return { ...first, fields };
  };
  try {
    let text = "";
    const nativeFields: Record<string, string | number> = {};
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
          const layerFields = extractFields(layer, kind);
          const layerComplete =
            kind === "identity"
              ? Boolean(
                  (layerFields.lastName || layerFields.lastNameLatin) &&
                  (layerFields.firstName || layerFields.firstNameLatin) &&
                  layerFields.lastNameLatin &&
                  layerFields.firstNameLatin &&
                  layerFields.birthDate,
                )
              : Boolean(
                  layerFields.amount !== undefined &&
                  layerFields.paymentDate &&
                  layerFields.receiptNumber &&
                  layerFields.recipientName &&
                  (!/Оплачено|Откуда|Төленді|Списано с|Төлем тәсілі|Payment method/iu.test(
                    layer,
                  ) ||
                    layerFields.method),
                );
          if (layer.replace(/\s/g, "").length > 40 && layerComplete) {
            text += layer + "\n";
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
          let scanned;
          try {
            scanned =
              kind === "receipt"
                ? await scanReceipt(rendered)
                : await scan(rendered);
          } catch (error) {
            if (
              kind !== "receipt" ||
              layerFields.amount === undefined ||
              !layerFields.paymentDate
            )
              throw error;
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
            const anchors =
              scanned.blocks?.flatMap((block) =>
                block.paragraphs.flatMap((paragraph) => paragraph.lines),
              ) || [];
            Object.assign(
              nativeFields,
              layerFields,
              identityDetails(layer + "\n" + scanned.text),
              extractIdentityLayout(values, anchors),
              machineReadableNames(layer),
            );
          }
        }
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else {
      const image = await sharp(buffer, { limitInputPixels: 25000000 })
        .rotate()
        .resize({ width: 2400, height: 3200, fit: "inside" })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
      if (kind === "receipt") {
        const scanned = await scanReceipt(image);
        text = scanned.text;
        Object.assign(nativeFields, scanned.fields);
      } else text = (await scan(image)).text;
    }
    return { ...extractFields(text, kind), ...nativeFields };
  } finally {
    await worker?.terminate();
  }
}
