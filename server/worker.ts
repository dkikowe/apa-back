import "dotenv/config";
import mongoose from "mongoose";
import { connect, Document } from "./models.js";
import { completeRecognition } from "./services/duplicates.js";
import { readingInterrupted, documentUnreadable } from "./services/document-errors.js";
import { storage } from "./services/storage.js";
import { recognize, WrongDocumentKindError } from "./services/ocr.js";
await connect();
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
console.info("OCR worker ready (local processing)");
while (!stopped) {
  await Document.updateMany(
    {
      status: "processing",
      startedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) },
    },
    {
      $set: {
        status: "failed",
        error: readingInterrupted,
      },
    },
  );
  const job = await Document.findOneAndUpdate(
    { status: "queued" },
    {
      $set: { status: "processing", startedAt: new Date() },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { createdAt: 1 } },
  );
  if (!job) {
    await new Promise((r) => setTimeout(r, 1500));
    continue;
  }
  try {
    const fields = await recognize(
      await storage.read(job.key!),
      job.mime!,
      job.kind!,
    );
    await completeRecognition(job, fields);
  } catch (error) {
    await Document.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          error:
            error instanceof WrongDocumentKindError
              ? error.message
              : documentUnreadable,
          completedAt: new Date(),
        },
      },
    );
  }
}
await mongoose.disconnect();
