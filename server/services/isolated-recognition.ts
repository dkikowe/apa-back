import { fork } from "node:child_process";
import type { recognize } from "./ocr.js";
import { WrongDocumentKindError } from "./ocr-policy.js";

type Arguments = Parameters<typeof recognize>;
type Fields = Awaited<ReturnType<typeof recognize>>;
type Result =
  { fields: Fields; conflicts: string[] } | { error: "wrong-kind" | "failed" };

// Native PDF rendering and a Tesseract worker can hang inside a single pass,
// beyond the engine's between-pass deadline. Isolate this stage so it can be
// stopped together with its worker threads, without blocking the queue.
export const isolatedRecognition: typeof recognize = (...args) =>
  new Promise<Fields>((resolve, reject) => {
    const child = fork(new URL(import.meta.url), ["--ocr-child"], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("OCR stage timed out"));
    }, 240_000);
    function fail() {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error("OCR process unavailable"));
    }
    child.once("error", fail);
    child.once("exit", fail);
    child.once("message", (result: Result) => {
      clearTimeout(timer);
      if ("error" in result) {
        reject(
          result.error === "wrong-kind"
            ? new WrongDocumentKindError()
            : new Error("OCR failed"),
        );
      } else {
        const conflicts = args[3]?.conflicts;
        if (conflicts)
          conflicts.splice(0, conflicts.length, ...result.conflicts);
        resolve(result.fields);
      }
      child.kill("SIGKILL");
    });
    child.send(args, (error) => {
      if (error) fail();
    });
  });

if (process.argv[2] === "--ocr-child" && process.send) {
  // Never continue an orphaned scan after the supervisor is gone.
  process.once("disconnect", () => process.exit(1));
  process.once("message", async (args: Arguments) => {
    let result: Result;
    try {
      const { recognize } = await import("./ocr.js");
      const fields = await recognize(...args);
      result = { fields, conflicts: args[3]?.conflicts ?? [] };
    } catch (error) {
      result = {
        error:
          error instanceof WrongDocumentKindError ? "wrong-kind" : "failed",
      };
    }
    process.send!(result);
  });
}
