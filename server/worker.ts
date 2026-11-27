import "dotenv/config";
import mongoose from "mongoose";
import { connect } from "./models.js";
import {
  claimRead,
  processRead,
  reclaimInterruptedRead,
} from "./services/recognition-jobs.js";
await connect();
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
console.info("OCR worker ready (local processing)");
let claims = 0;
while (!stopped) {
  try {
    await reclaimInterruptedRead();
    const job = await claimRead(new Date(), claims % 4 === 3);
    if (job) {
      claims++;
      await processRead(job);
      continue;
    }
  } catch {
    // An unavailable database should not permanently stop the queue.
    console.warn("OCR queue temporarily unavailable");
  }
  await new Promise((r) => setTimeout(r, 1500));
}
await mongoose.disconnect();
