import { randomUUID } from "node:crypto";
import { Document } from "../models.js";
import { missingDocumentFields } from "../../shared/document-recognition.js";
import {
  completeRecognition,
  readerVersion,
  recognitionConflict,
} from "./duplicates.js";
import { documentUnreadable, readingInterrupted } from "./document-errors.js";
import { OCR_LAST_ROUND, WrongDocumentKindError } from "./ocr-policy.js";
import { isolatedRecognition } from "./isolated-recognition.js";
import { storage } from "./storage.js";

const leaseMs = 90_000;
const retryDelaysMs = [2_000, 10_000];

export async function claimRead(now = new Date()) {
  return Document.findOneAndUpdate(
    {
      status: "queued",
      $or: [{ nextReadAt: null }, { nextReadAt: { $lte: now } }],
    },
    [
      {
        $set: {
          status: "processing",
          startedAt: now,
          readLease: randomUUID(),
          leaseUntil: new Date(+now + leaseMs),
          // Count a full cycle once, independently of automatic stages and
          // transient retries, so the explicit retry limit retains its meaning.
          attempts: {
            $add: [
              { $ifNull: ["$attempts", 0] },
              {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $ifNull: ["$recoveryStage", 0] }, 0] },
                      { $eq: [{ $ifNull: ["$recoveryFailures", 0] }, 0] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            ],
          },
        },
      },
    ],
    { new: true, sort: { updatedAt: 1, _id: 1 } },
  ).lean();
}
type Job = NonNullable<Awaited<ReturnType<typeof claimRead>>>;

async function failRead(
  job: Job,
  message: string,
  terminal: boolean,
  now: Date,
  reason: "interrupted" | "storage" | "engine" = "storage",
) {
  const failures = job.recoveryFailures ?? 0;
  const delay = terminal ? undefined : retryDelaysMs[failures];
  const retrying = delay !== undefined;
  const stage = job.recoveryStage ?? 0;
  const advance = retrying && reason === "engine" && stage < OCR_LAST_ROUND;
  const filter = {
    _id: job._id,
    status: "processing",
    readLease: job.readLease ?? null,
    ...(reason === "interrupted"
      ? { leaseUntil: job.leaseUntil ?? null, startedAt: job.startedAt }
      : {}),
  };
  // A failed refinement must not discard the successful previous stage.
  const useCheckpoint =
    !retrying &&
    !terminal &&
    (job.recoveryStage ?? 0) > 0 &&
    Object.keys(job.fields ?? {}).length > 0;
  const duplicate = useCheckpoint
    ? await recognitionConflict(job, job.fields)
    : null;
  await Document.updateOne(filter, {
    $set: {
      status: duplicate
        ? "duplicate"
        : retrying
          ? "queued"
          : useCheckpoint
            ? "done"
            : "failed",
      ...(duplicate ? { duplicate, error: duplicate.message } : {}),
      recoveryFailures: failures + 1,
      ...(advance
        ? { recoveryStage: stage + 1, ...(stage === 0 ? { fields: {} } : {}) }
        : {}),
      ...(retrying
        ? { nextReadAt: new Date(+now + delay) }
        : {
            completedAt: now,
            recognitionVersion: readerVersion(job.kind),
            ...(!useCheckpoint ? { error: message } : {}),
          }),
    },
    $unset: {
      readLease: 1,
      leaseUntil: 1,
      ...(retrying
        ? { error: 1, completedAt: 1 }
        : {
            nextReadAt: 1,
            ...(useCheckpoint && !duplicate ? { error: 1 } : {}),
          }),
    },
  });
}

export async function reclaimInterruptedRead(now = new Date()) {
  const stale = await Document.findOne({
    status: "processing",
    $or: [
      { leaseUntil: { $lte: now, $type: "date" } },
      { leaseUntil: null, startedAt: { $lte: new Date(+now - 10 * 60_000) } },
    ],
  })
    .sort({ startedAt: 1 })
    .lean();
  if (stale)
    await failRead(stale, readingInterrupted, false, now, "interrupted");
}

async function readFile(key: string) {
  const file = await storage.open(key, AbortSignal.timeout(60_000));
  if (!file.Body) throw new Error("Empty storage response");
  return Buffer.from(await file.Body.transformToByteArray());
}

export async function processRead(
  job: Job,
  load = readFile,
  run = isolatedRecognition,
) {
  const ownership = {
    _id: job._id,
    status: "processing",
    readLease: job.readLease,
  };
  const heartbeat = setInterval(() => {
    void Document.updateOne(ownership, {
      $set: { leaseUntil: new Date(Date.now() + leaseMs) },
    }).catch(() => {}); // Expiry and the lease guard recover a disconnected worker.
  }, leaseMs / 3);
  heartbeat.unref();
  const stage = job.recoveryStage ?? 0;
  const conflicts = [...(job.recoveryConflicts || [])];
  let runningEngine = false;
  try {
    const bytes = await load(job.key!);
    runningEngine = true;
    const fields = await run(bytes, job.mime!, job.kind!, {
      recoveryStage: stage,
      previousFields: stage ? job.fields : undefined,
      conflicts,
    });
    runningEngine = false;
    const missing = missingDocumentFields(
      job.kind === "identity" ? "identity" : "receipt",
      fields,
    );
    const nextStage =
      missing.length && stage < OCR_LAST_ROUND ? stage + 1 : undefined;
    await completeRecognition(job, fields, { nextStage, conflicts });
  } catch (error) {
    const wrongKind = error instanceof WrongDocumentKindError;
    await failRead(
      job,
      wrongKind ? error.message : documentUnreadable,
      wrongKind,
      new Date(),
      runningEngine ? "engine" : "storage",
    );
  } finally {
    clearInterval(heartbeat);
  }
}
