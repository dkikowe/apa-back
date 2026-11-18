import "dotenv/config";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { recognize } from "../server/services/ocr.js";
const image = await sharp(await readFile(".local/fixtures/receipt.png"))
  .jpeg({ quality: 95 })
  .toBuffer();
const drawing = "q 750 0 0 360 0 0 cm /Im1 Do Q";
const objects: Buffer[] = [
  Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
  Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
  Buffer.from(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 750 360] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
  ),
  Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width 1500 /Height 720 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
    ),
    image,
    Buffer.from("\nendstream"),
  ]),
  Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
];
let result = Buffer.from("%PDF-1.4\n");
const offsets: number[] = [];
objects.forEach((object, i) => {
  offsets.push(result.length);
  result = Buffer.concat([
    result,
    Buffer.from(`${i + 1} 0 obj\n`),
    object,
    Buffer.from("\nendobj\n"),
  ]);
});
const xref = result.length;
result = Buffer.concat([
  result,
  Buffer.from(
    "xref\n0 6\n0000000000 65535 f \n" +
      offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  ),
]);
await writeFile(".local/fixtures/scanned-receipt.pdf", result);
const fields = await recognize(result, "application/pdf", "receipt");
assert.equal(fields.amount, 109000);
assert.equal(fields.paymentDate, "2026-11-18");
console.info("PASS: scanned PDF rendered locally and recognized by Tesseract.");
