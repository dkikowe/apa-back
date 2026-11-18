import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
if (existsSync(".env"))
  throw new Error(".env already exists; it has not been overwritten.");
await mkdir(".local", { recursive: true });
const password = randomBytes(15).toString("base64url"),
  secret = randomBytes(32).toString("hex"),
  storagePassword = randomBytes(24).toString("hex");
await writeFile(
  ".env",
  `NODE_ENV=development\nPORT=3001\nAPP_ORIGIN=http://localhost:5173\nMONGODB_URI=mongodb://127.0.0.1:27018/amanat?replicaSet=rs0\nSESSION_SECRET=${secret}\nS3_ENDPOINT=http://127.0.0.1:9000\nS3_REGION=us-east-1\nS3_BUCKET=amanat-private\nS3_ACCESS_KEY_ID=local-development\nS3_SECRET_ACCESS_KEY=${storagePassword}\nS3_FORCE_PATH_STYLE=true\nS3_PROVIDER=minio\nS3_ENCRYPTION=none\nOCR_LANG_PATH=.local/tessdata\nOCR_LANGUAGES=kaz+rus+eng\nADMIN_USERNAME=apa\nADMIN_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
await writeFile(
  ".local/ACCESS.md",
  `# Локальный вход (только вымышленные данные)\n\nАдрес: http://localhost:5173\n\nЛогин: apa\n\nПароль: ${password}\n\nПароль создан случайно и не включён в Git. Для рабочей системы создайте отдельного администратора и удалите тестовые данные.\n`,
  { mode: 0o600 },
);
console.info("Created local .env and .local/ACCESS.md. No secrets printed.");
