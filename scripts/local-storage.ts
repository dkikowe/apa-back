import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
await mkdir(".local/storage", { recursive: true });
const child = spawn(
  process.env.MINIO_BINARY || ".local/bin/minio",
  [
    "server",
    ".local/storage",
    "--address",
    "127.0.0.1:9000",
    "--console-address",
    "127.0.0.1:9001",
  ],
  {
    env: {
      ...process.env,
      MINIO_ROOT_USER: process.env.S3_ACCESS_KEY_ID,
      MINIO_ROOT_PASSWORD: process.env.S3_SECRET_ACCESS_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
child.on("error", () => {
  console.error(
    "MinIO could not start. Use Docker Compose or install .local/bin/minio.",
  );
  process.exit(1);
});
child.on("spawn", () =>
  console.info(
    "Local storage starting on 127.0.0.1:9000 (credentials omitted).",
  ),
);
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
