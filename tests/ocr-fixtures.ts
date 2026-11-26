import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
export function textImage(lines: string[]) {
  const canvas = createCanvas(1700, 120 + lines.length * 95);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  context.font = "42px Arial";
  lines.forEach((line, i) => context.fillText(line, 60, 80 + i * 95));
  return canvas.toBuffer("image/png");
}
function pdfObjects(objects: Buffer[]) {
  let data = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(data.length);
    data = Buffer.concat([
      data,
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
  });
  const xref = data.length;
  return Buffer.concat([
    data,
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets
          .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
          .join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  ]);
}
export function textPdf(...pages: string[][]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const lines of pages) {
    const content =
      "BT /F1 22 Tf 40 800 Td 35 TL " +
      lines.map((line, i) => `${i ? "T* " : ""}(${line}) Tj`).join("\n") +
      " ET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 850 1000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  return pdfObjects(objects.map((v) => Buffer.from(v)));
}
export async function imagePdf(png: Buffer, footer = false, overlay = "") {
  const image = await sharp(png).jpeg({ quality: 95 }).toBuffer();
  const meta = await sharp(image).metadata();
  const w = meta.width! / 2,
    h = meta.height! / 2;
  const drawing =
    `q ${w} 0 0 ${h} 0 80 cm /Im1 Do Q` +
    (footer
      ? "\nBT /F1 12 Tf 20 20 Td (Synthetic scanned document for local validation without real personal data) Tj ET"
      : "") +
    overlay;
  return pdfObjects([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h + 80}] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${meta.width} /Height ${meta.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(
      `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
}

export async function hybridIdentityPdf() {
  const canvas = createCanvas(1700, 1000);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1700, 1000);
  ctx.fillStyle = "black";
  ctx.font = "26px Arial";
  ["SURNAME", "GIVEN NAMES", "DATE OF BIRTH"].forEach((label, i) =>
    ctx.fillText(label, 80, 90 + i * 220),
  );
  // Labels are pixels; values and the MRZ-like name line are native PDF text.
  const overlay =
    ["ULGIKYZY", "AIGUL", "15.04.1975"]
      .map(
        (value, i) =>
          `\nBT /F1 20 Tf 40 ${580 - (160 + i * 220) / 2} Td (${value}) Tj ET`,
      )
      .join("") +
    "\nBT /F1 16 Tf 40 120 Td (ULGIKYZY<<AIGUL<<<<<<<<<<<<<<<<<<<<) Tj ET";
  return imagePdf(canvas.toBuffer("image/png"), false, overlay);
}

// The PDF text layer has complete names/date, but the IIN exists only as pixels.
export async function mixedIdentityIinPdf() {
  return imagePdf(
    textImage(["IIN: 000123456789"]),
    false,
    "\nBT /F1 16 Tf 40 65 Td (SURNAME: ULGIKYZY) Tj ET" +
      "\nBT /F1 16 Tf 40 45 Td (GIVEN NAMES: AIGUL) Tj ET" +
      "\nBT /F1 16 Tf 40 25 Td (DATE OF BIRTH: 15.04.1975) Tj ET",
  );
}
