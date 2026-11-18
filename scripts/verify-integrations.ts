import "dotenv/config";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { writeFile, mkdir } from "node:fs/promises";
import { recognize } from "../server/services/ocr.js";
if (process.env.NODE_ENV === "production")
  throw new Error("Only synthetic local development verification is allowed.");
const origin = process.env.API_ORIGIN || "http://127.0.0.1:3001";
const login = await fetch(origin + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  }),
});
assert.equal(login.status, 200);
const { csrf } = (await login.json()) as any;
const cookie = login.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .join("; ");
async function call(route: string, body?: any, method = "POST") {
  const response = await fetch(origin + "/api" + route, {
    method: body === undefined ? "GET" : method,
    headers: {
      cookie,
      "x-csrf-token": csrf,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
await mkdir(".local/fixtures", { recursive: true });
const canvas = createCanvas(1500, 720);
const context = canvas.getContext("2d");
context.fillStyle = "white";
context.fillRect(0, 0, 1500, 720);
context.fillStyle = "#111";
context.font = "40px Arial";
const lines = [
  `SYNTHETIC TEST RECEIPT ${Date.now()}`,
  "TOTAL: 1090.00",
  "DATE: 18.11.2026",
  "RECIPIENT: TEST ORGANIZATION",
  "RECEIPT NUMBER: SYNTHETIC-OCR-001",
];
lines.forEach((line, i) => context.fillText(line, 70, 110 + i * 110));
const png = canvas.toBuffer("image/png");
await writeFile(".local/fixtures/receipt.png", png);
const form = new FormData();
form.set("kind", "receipt");
form.set(
  "file",
  new Blob([new Uint8Array(png)], { type: "image/png" }),
  "synthetic-receipt.png",
);
const uploaded = await fetch(origin + "/api/documents", {
  method: "POST",
  headers: { cookie, "x-csrf-token": csrf },
  body: form,
});
assert.equal(uploaded.status, 201);
const document = (await uploaded.json()) as any;
let job: any;
for (let attempt = 0; attempt < 120; attempt++) {
  job = (await call("/documents/" + document.id)).body;
  if (["done", "failed"].includes(job.status)) break;
  await new Promise((r) => setTimeout(r, 500));
}
assert.equal(job.status, "done", job.error || "OCR timeout");
assert.equal(job.fields.amount, 109000);
assert.equal(job.fields.paymentDate, "2026-11-18");
const signed = (await call(`/documents/${document.id}/url`)).body.url;
const original = await fetch(signed);
assert.equal(original.status, 200);
assert.equal((await original.arrayBuffer()).byteLength, png.length);
const anonymous = new URL(signed);
anonymous.search = "";
assert.equal((await fetch(anonymous)).status, 403);
const participant = await call("/participants", {
  lastName: "OCRсынақ",
  firstName: "Үлгі",
  birthDate: "1961-01-10",
  region: "Ақтау",
  phone: "+7 000 000 9988",
});
assert.equal(participant.status, 201);
const payment = {
  ...job.fields,
  year: 2026,
  receiptDocumentId: document.id,
  receiptNumber: `SYNTHETIC-OCR-${Date.now()}`,
};
const saved = await call(
  `/participants/${participant.body._id}/payments`,
  payment,
);
assert.equal(saved.status, 201);
assert.equal(
  (await call(`/participants/${participant.body._id}/payments`, payment))
    .status,
  409,
);
const member = (await call(`/participants/${participant.body._id}?year=2026`))
  .body;
assert.equal(member.remaining, 539700);
const content =
  "BT /F1 22 Tf 40 750 Td 30 TL " +
  lines.map((line, i) => `${i ? "T* " : ""}(${line}) Tj`).join("\n") +
  " ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 900] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf +=
  `xref\n0 6\n0000000000 65535 f \n` +
  offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("") +
  `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdfBuffer = Buffer.from(pdf);
await writeFile(".local/fixtures/receipt.pdf", pdfBuffer);
const fields = await recognize(pdfBuffer, "application/pdf", "receipt");
assert.equal(fields.amount, 109000);
assert.equal(fields.receiptNumber, "SYNTHETIC-OCR-001");
console.info(
  "PASS: real S3 upload, local image OCR, PDF text extraction, private anonymous 403, signed document 200, payment 1090→5397, duplicate 409.",
);
