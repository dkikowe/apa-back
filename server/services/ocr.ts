import { createWorker } from "tesseract.js";
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
    "ЧЕК НӨМІРІ",
    "TRANSACTION NUMBER",
    "TRANSACTION ID",
    "RECEIPT NUMBER",
    "ЧЕК №",
  ],
  method: ["СПОСОБ ОПЛАТЫ", "ТӨЛЕМ ТӘСІЛІ", "PAYMENT METHOD"],
};
const prefix = (values: string[]) =>
  new RegExp("^(?:" + values.join("|") + ")(?=\\s|[:/|–—-]|$)", "iu");
const anyLabel = prefix(Object.values(labels).flat());
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
      if (value && !anyLabel.test(value)) return value.trim();
    }
    return undefined;
  }
  if (kind === "identity") {
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
  return fields;
}
export async function recognize(buffer: Buffer, mime: string, kind: string) {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  const scan = async (image: Buffer) => {
    worker ??= await createWorker(
      (process.env.OCR_LANGUAGES || "kaz+rus+eng").split("+"),
      1,
      {
        langPath: process.env.OCR_LANG_PATH || ".local/tessdata",
        cacheMethod: "none",
        gzip: true,
        logger: () => {},
        errorHandler: () => {},
      },
    );
    return (await worker.recognize(image)).data.text;
  };
  try {
    let text = "";
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
          if (
            layer.replace(/\s/g, "").length > 40 &&
            Object.keys(extractFields(layer, kind)).length > 0
          ) {
            text += layer + "\n";
            continue;
          }
          const viewport = page.getViewport({ scale: 2 });
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
          text += (await scan(canvas.toBuffer("image/png"))) + "\n";
        }
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else {
      text = await scan(
        await sharp(buffer, { limitInputPixels: 25000000 })
          .rotate()
          .resize({ width: 2400, withoutEnlargement: true })
          .grayscale()
          .normalize()
          .png()
          .toBuffer(),
      );
    }
    return extractFields(text, kind);
  } finally {
    await worker?.terminate();
  }
}
