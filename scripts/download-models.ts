import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const target = process.env.OCR_LANG_PATH || ".local/tessdata";
await mkdir(target, { recursive: true });
for (const language of (process.env.OCR_LANGUAGES || "kaz+rus+eng").split(
  "+",
)) {
  if (!/^[a-z]{3}$/.test(language)) throw new Error("Invalid language");
  const response = await fetch(
    `https://tessdata.projectnaptha.com/4.0.0/${language}.traineddata.gz`,
  );
  if (!response.ok)
    throw new Error(`Cannot download ${language}: ${response.status}`);
  await writeFile(
    path.join(target, `${language}.traineddata.gz`),
    Buffer.from(await response.arrayBuffer()),
  );
  console.info(`Installed ${language} OCR model`);
}
