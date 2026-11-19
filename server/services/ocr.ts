import { createWorker, PSM } from "tesseract.js";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { parseMoney } from "../../shared/domain.js";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
function dateValue(raw: string) {
  const isoMatch = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const localMatch = raw.match(/\b(\d{2})[./-](\d{2})[./-](\d{4})\b/);
  const iso = isoMatch
    ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    : localMatch
      ? `${localMatch[3]}-${localMatch[2]}-${localMatch[1]}`
      : undefined;
  return iso &&
    !isNaN(Date.parse(iso)) &&
    new Date(iso).toISOString().slice(0, 10) === iso
    ? iso
    : undefined;
}
const labels = {
  lastName: ["ТЕГІ", "ФАМИЛИЯ", "SURNAME"],
  firstName: ["АТЫ", "ИМЯ", "GIVEN NAMES", "GIVEN NAME", "FIRST NAME", "NAME"],
  middleName: ["ӘКЕСІНІҢ АТЫ", "ОТЧЕСТВО", "PATRONYMIC"],
  birthDate: ["ТУҒАН КҮНІ", "ДАТА РОЖДЕНИЯ", "DATE OF BIRTH"],
  iin: ["ЖСН", "ИИН", "IIN"],
  documentNumber: [
    "КУӘЛІК НӨМІРІ",
    "ҚҰЖАТ НӨМІРІ",
    "НОМЕР УДОСТОВЕРЕНИЯ",
    "НОМЕР ДОКУМЕНТА",
    "DOCUMENT NUMBER",
    "DOCUMENT NO",
  ],
  issuedBy: [
    "БЕРГЕН ОРГАН",
    "БЕРГЕН ОРГАНЫ",
    "ОРГАН ВЫДАЧИ",
    "КЕМ ВЫДАН",
    "ISSUED BY",
    "AUTHORITY",
  ],
  issueDate: ["БЕРІЛГЕН КҮНІ", "ДАТА ВЫДАЧИ", "DATE OF ISSUE"],
  expiryDate: [
    "ҚОЛДАНЫЛУ МЕРЗІМІ",
    "ЖАРАМДЫЛЫҚ МЕРЗІМІ",
    "ДЕЙСТВИТЕЛЕН ДО",
    "СРОК ДЕЙСТВИЯ",
    "DATE OF EXPIRY",
  ],
  amount: [
    "ТӨЛЕМ СОМАСЫ",
    "АУДАРЫМ СОМАСЫ",
    "СУММА ПЕРЕВОДА",
    "СУММА ПЛАТЕЖА",
    "СУММА",
    "СОМАСЫ",
    "ИТОГО",
    "TOTAL",
    "AMOUNT",
  ],
  paymentDate: [
    "ДАТА И ВРЕМЯ",
    "ДАТАИ ВРЕМЯ",
    "ДАТА ПЛАТЕЖА",
    "ДАТА ПЕРЕВОДА",
    "ТӨЛЕМ КҮНІ",
    "КҮНІ",
    "ДАТА",
    "DATE",
  ],
  recipientName: ["ПОЛУЧАТЕЛЬ", "АЛУШЫ", "RECIPIENT"],
  receiptNumber: [
    "НОМЕР ТРАНЗАКЦИИ",
    "НОМЕР ЧЕКА",
    "№ ЧЕКА",
    "ЧЕКТІҢ НӨМІРІ",
    "ЧЕК НӨМІРІ",
    "TRANSACTION NUMBER",
    "TRANSACTION ID",
    "RECEIPT NUMBER",
    "ЧЕК №",
  ],
  method: ["СПОСОБ ОПЛАТЫ", "ТӨЛЕМ ТӘСІЛІ", "PAYMENT METHOD", "ОПЛАЧЕНО"],
};
const prefix = (values: string[]) =>
  new RegExp("^(?:" + values.join("|") + ")(?=\\s|[:/|–—-]|$)", "iu");
const anyLabel = prefix(Object.values(labels).flat());
export type PositionedText = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};
// Use the printed label's position to bind a native PDF value to its field.
// Native text preserves letters such as Ұ which image OCR may confuse with У.
export function extractIdentityLayout(
  values: PositionedText[],
  anchors: PositionedText[],
) {
  const result: Record<string, string | number> = {};
  for (const key of [
    "lastName",
    "firstName",
    "middleName",
    "birthDate",
    "iin",
    "documentNumber",
    "issuedBy",
    "issueDate",
    "expiryDate",
  ] as const) {
    const found: string[] = [];
    for (const anchor of anchors) {
      if (!prefix(labels[key]).test(anchor.text.trim())) continue;
      const height = Math.max(1, anchor.bbox.y1 - anchor.bbox.y0);
      const candidates = values
        .filter((value) => {
          const gap = value.bbox.y0 - anchor.bbox.y1;
          return (
            value.text.trim() &&
            !anyLabel.test(value.text.trim()) &&
            gap >= -height * 0.3 &&
            gap <= height * 5 &&
            Math.abs(value.bbox.x0 - anchor.bbox.x0) <= height * 2 &&
            ![...anchors, ...values].some(
              (other) =>
                other !== anchor &&
                anyLabel.test(other.text.trim()) &&
                other.bbox.y0 >= anchor.bbox.y1 &&
                other.bbox.y0 < value.bbox.y0 &&
                Math.abs(other.bbox.x0 - anchor.bbox.x0) <= height * 2,
            )
          );
        })
        .sort((a, b) => a.bbox.y0 - b.bbox.y0);
      // Ambiguous columns or several native fragments on the same line need manual review.
      if (
        !candidates.length ||
        (candidates[1] &&
          Math.abs(candidates[1].bbox.y0 - candidates[0].bbox.y0) < height)
      )
        continue;
      const value = candidates[0].text.trim();
      if (
        key.endsWith("Date")
          ? Boolean(dateValue(value))
          : key === "iin"
            ? /^\d{12}$/.test(value)
            : key === "documentNumber"
              ? /^[A-Za-zА-Яа-я0-9 -]{3,30}$/.test(value)
              : key === "issuedBy"
                ? value.length >= 3 && value.length <= 200
                : /^[\p{Script=Cyrillic}A-Za-z\s’'-]{2,100}$/u.test(value)
      )
        found.push(value);
    }
    if (new Set(found).size === 1) {
      Object.assign(
        result,
        extractFields(labels[key][0] + "\n" + found[0], "identity"),
      );
    }
  }
  return result;
}
function machineReadableNames(text: string) {
  const matches = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 25)
    .map((line) =>
      line.match(/^([A-Z]+(?:<[A-Z]+)*)<<([A-Z]+(?:<[A-Z]+)*)<{2,}$/),
    )
    .filter((match) => match !== null);
  if (matches.length !== 1) return {};
  return {
    lastNameLatin: matches[0][1].replaceAll("<", " "),
    firstNameLatin: matches[0][2].replaceAll("<", " "),
  };
}
export function receiptAmount(raw: string) {
  if (/^\s*[-−]/.test(raw)) return undefined;
  const matched = raw.match(/[-+]?\d(?:[\d\s.,'’]*\d)?/);
  if (!matched || matched[0].startsWith("-")) return undefined;
  let value = matched[0].replace(/[\s'’+]/g, "");
  const comma = value.lastIndexOf(","),
    dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".",
      group = decimal === "," ? "." : ",";
    const [whole, fraction, ...rest] = value.split(decimal);
    if (
      rest.length ||
      !/^\d{1,2}$/.test(fraction) ||
      !new RegExp("^\\d{1,3}(?:\\" + group + "\\d{3})+$").test(whole)
    )
      return undefined;
    value = whole.split(group).join("") + "." + fraction;
  } else if (comma >= 0 || dot >= 0) {
    const sep = comma >= 0 ? "," : ".",
      parts = value.split(sep);
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1]))
      value = parts[0] + "." + parts[1];
    else if (
      /^\d{1,3}$/.test(parts[0]) &&
      parts.slice(1).every((p) => /^\d{3}$/.test(p))
    )
      value = parts.join("");
    else return undefined;
  }
  try {
    return parseMoney(value);
  } catch {
    return undefined;
  }
}
function identityDetails(text: string) {
  const result: Record<string, string> = {};
  if (!/ЖЕКЕ\s+КУ[ӘА]ЛІК|УДОСТОВЕРЕНИЕ\s+ЛИЧНОСТИ/iu.test(text)) return result;
  const lines = text.split(/\r?\n/).map((v) => v.trim());
  for (const [key, length] of [
    ["iin", 12],
    ["documentNumber", 9],
  ] as const) {
    const values = [
      ...new Set(
        lines.filter((line) => new RegExp(`^\\d{${length}}$`).test(line)),
      ),
    ];
    if (values.length === 1) result[key] = values[0];
  }
  if (/БЕРІЛГЕН\s+КҮНІ|ДАТА\s+ВЫДАЧИ/iu.test(text)) {
    const ranges = [
      ...text.matchAll(
        /(\d{2}[./]\d{2}[./]\d{4})\s*[-–—]\s*(\d{2}[./]\d{2}[./]\d{4})/g,
      ),
    ];
    const unique = [...new Set(ranges.map((r) => r[1] + "|" + r[2]))];
    if (unique.length === 1) {
      const [a, b] = unique[0].split("|");
      const start = dateValue(a),
        end = dateValue(b);
      if (start && end && start <= end) {
        result.issueDate = start;
        result.expiryDate = end;
      }
    }
  }
  return result;
}
export function extractFields(text: string, kind: string) {
  const lines = text
    .normalize("NFC")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const fields: Record<string, string | number> = {};
  function labeled(aliases: string[]) {
    const expression = prefix(aliases);
    for (let i = 0; i < lines.length; i++) {
      if (!expression.test(lines[i])) continue;
      let value = lines[i].replace(expression, "").replace(/^[\s:/|]+/, "");
      // A bilingual heading is one label, never the person's name.
      while (expression.test(value))
        value = value.replace(expression, "").replace(/^[\s:/|]+/, "");
      if (!value) value = lines[i + 1] || "";
      // Some receipts put timezone wording between the date label and value.
      if (/^(?:по Астане|Астана уақыты бойынша)$/iu.test(value))
        value = lines[i + 2] || "";
      value = value.replace(/^по Астане\s*/iu, "");
      if (value && !anyLabel.test(value)) return value.trim();
    }
    return undefined;
  }
  if (kind === "identity") {
    Object.assign(fields, machineReadableNames(text), identityDetails(text));
    for (const key of ["lastName", "firstName", "middleName"] as const) {
      const value = labeled(labels[key]);
      if (!value) continue;
      const chunks = value.split(/\s*[/|]\s*/);
      const cyrillic = chunks.find((v) =>
        /^[\p{Script=Cyrillic}\s’'-]{2,100}$/u.test(v),
      );
      const latin = chunks.find((v) => /^[A-Za-z\s’'-]{2,100}$/.test(v));
      if (cyrillic) fields[key] = cyrillic;
      if (latin && key !== "middleName") fields[key + "Latin"] = latin;
    }
    // Separate English labels can coexist with Cyrillic labels on the same document.
    for (const [key, aliases] of [
      ["lastNameLatin", ["SURNAME"]],
      ["firstNameLatin", ["GIVEN NAMES", "GIVEN NAME", "FIRST NAME", "NAME"]],
    ] as const) {
      const value = labeled([...aliases]);
      if (value && /^[A-Za-z\s’'-]{2,100}$/.test(value)) fields[key] = value;
    }
    for (const key of [
      "iin",
      "documentNumber",
      "issuedBy",
      "issueDate",
      "expiryDate",
    ] as const) {
      const value = labeled(labels[key]);
      if (!value) continue;
      if (key.endsWith("Date")) {
        const date = dateValue(value);
        if (date) fields[key] = date;
      } else if (key === "iin") {
        const number = value.replace(/\s/g, "");
        if (/^\d{12}$/.test(number)) fields[key] = number;
      } else if (key === "documentNumber") {
        const number = value.replace(/^№\s*/, "");
        if (/^[A-Za-zА-Яа-я0-9 -]{3,30}$/.test(number)) fields[key] = number;
      } else if (value.length >= 3 && value.length <= 200) fields[key] = value;
    }
    const birth = labeled(labels.birthDate);
    if (birth) {
      const date = dateValue(birth);
      if (date) fields.birthDate = date;
    }
  } else {
    const amount = labeled(labels.amount);
    if (amount) {
      const parsed = receiptAmount(amount);
      if (parsed !== undefined) fields.amount = parsed;
    }
    // Successful QR receipts show a standalone currency amount below the status.
    // Never use the merchant IIN, a card number, or an arbitrary unlabeled number.
    if (fields.amount === undefined) {
      const success = lines.findIndex((line) =>
        /^(?:Оплата совершена|Плат[её]ж выполнен|Төлем жасалды|Төлем сәтті орындалды)$/iu.test(
          line,
        ),
      );
      if (success >= 0) {
        const candidates = lines
          .slice(success + 1, success + 2)
          .filter((line) =>
            /^[\d\s.,'’]+\s*(?:₸|KZT|тенге|тг|Т|T)[.]?$/iu.test(line),
          );
        if (candidates.length === 1) {
          const amount = receiptAmount(candidates[0]);
          if (amount !== undefined) fields.amount = amount;
        }
      }
    }
    const date = labeled(labels.paymentDate);
    if (date) {
      const parsed = dateValue(date);
      if (parsed) fields.paymentDate = parsed;
    }
    for (const key of ["recipientName", "receiptNumber", "method"] as const) {
      const value = labeled(labels[key]);
      if (value)
        fields[key] = value.slice(0, key === "recipientName" ? 200 : 150);
    }
  }
  if (
    kind === "receipt" &&
    !fields.recipientName &&
    /Оплата совершена|Төлем жасалды/iu.test(text)
  ) {
    const merchants = lines
      .map((line) => line.replace(/^[оoОO0]\s+(?=ИП|ТОО|ЖК|ЖШС)/u, ""))
      .filter((line) => /^(?:ИП|ТОО|ЖК|ЖШС)\s+.{2,190}$/u.test(line));
    if (merchants.length === 1) fields.recipientName = merchants[0];
  }
  return fields;
}
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
  const scan = async (image: Buffer) => {
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
      tessedit_pageseg_mode: kind === "identity" ? PSM.SPARSE_TEXT : PSM.AUTO,
    });
    return (
      await worker.recognize(
        image,
        {},
        { text: true, blocks: kind === "identity" },
      )
    ).data;
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
                  layerFields.birthDate,
                )
              : Boolean(
                  layerFields.amount !== undefined &&
                  layerFields.paymentDate &&
                  layerFields.receiptNumber,
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
          const scanned = await scan(canvas.toBuffer("image/png"));
          text += scanned.text + "\n";
          if (kind === "receipt") Object.assign(nativeFields, layerFields);
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
      text = (
        await scan(
          await sharp(buffer, { limitInputPixels: 25000000 })
            .rotate()
            .resize({ width: 2400, withoutEnlargement: true })
            .grayscale()
            .normalize()
            .png()
            .toBuffer(),
        )
      ).text;
    }
    return { ...extractFields(text, kind), ...nativeFields };
  } finally {
    await worker?.terminate();
  }
}
