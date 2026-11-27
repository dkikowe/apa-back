import { randomUUID } from "node:crypto";
import { Document } from "../models.js";
import { missingDocumentFields } from "../../shared/document-recognition.js";
import { completeRecognition, readerVersion } from "./duplicates.js";
import {
  documentUnreadable,
  originalFileMissing,
  readingInterrupted,
} from "./document-errors.js";
import { InvalidDocumentError, WrongDocumentKindError } from "./ocr-policy.js";
import { isolatedRecognition } from "./isolated-recognition.js";
import { storage } from "./storage.js";

const leaseMs = 90_000;
const failureDelays = [
  2_000, 10_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000,
];
const stalledDelays = [
  10_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
];
const fastStages = 5;

function delayFor(delays: number[], round: number) {
  return delays[Math.min(Math.max(round, 0), delays.length - 1)];
}

export async function claimRead(now = new Date(), oldestFirst = false) {
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
          // transient retries, which belong to the same user request.
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
    {
      new: true,
      // Fresh uploads have no nextReadAt. Periodic oldest-first turns also
      // guarantee overdue refinements a turn during a continuous upload stream.
      sort: oldestFirst
        ? { updatedAt: 1, _id: 1 }
        : { nextReadAt: 1, updatedAt: 1, _id: 1 },
    },
  ).lean();
}
type Job = NonNullable<Awaited<ReturnType<typeof claimRead>>>;

async function failRead(
  job: Job,
  message: string,
  reason: "interrupted" | "storage" | "engine" | "wrong-kind" | "invalid",
  now: Date,
) {
  const failures = job.recoveryFailures ?? 0;
  const stage = job.recoveryStage ?? 0;
  const permanent = reason === "wrong-kind" || reason === "invalid";
  const changeStrategy =
    reason === "engine" || (reason === "interrupted" && failures > 0);
  const filter = {
    _id: job._id,
    status: "processing",
    readLease: job.readLease ?? null,
    ...(reason === "interrupted"
      ? { leaseUntil: job.leaseUntil ?? null, startedAt: job.startedAt }
      : {}),
  };
  // Transport failures retry the same strategy; a stalled native reader
  // yields the next visual strategy a turn. Never erase a saved checkpoint.
  await Document.updateOne(filter, {
    $set: {
      status: permanent ? "failed" : "queued",
      wrongDocumentKind: reason === "wrong-kind",
      permanentReadFailure: permanent,
      recoveryFailures: failures + 1,
      ...(changeStrategy
        ? {
            recoveryStage: stage + 1,
            ...(stage === 0 ? { recoveryHasCheckpoint: false } : {}),
          }
        : {}),
      ...(permanent
        ? {
            completedAt: now,
            error: message,
            recognitionVersion: readerVersion(job.kind),
          }
        : { nextReadAt: new Date(+now + delayFor(failureDelays, failures)) }),
    },
    $unset: {
      readLease: 1,
      leaseUntil: 1,
      ...(permanent ? { nextReadAt: 1 } : { error: 1, completedAt: 1 }),
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
  if (stale) await failRead(stale, readingInterrupted, "interrupted", now);
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
  const previous =
    stage && job.recoveryHasCheckpoint !== false ? job.fields || {} : {};
  const kind = job.kind === "identity" ? "identity" : "receipt";
  let runningEngine = false;
  try {
    const bytes = await load(job.key!);
    runningEngine = true;
    const fields = await run(bytes, job.mime!, job.kind!, {
      recoveryStage: stage,
      previousFields: stage ? previous : undefined,
      conflicts,
    });
    runningEngine = false;
    const missing = missingDocumentFields(kind, fields);
    const progress = missingDocumentFields(kind, previous).some(
      (key) => !missing.includes(key),
    );
    const stalls =
      progress || stage < fastStages - 1 ? 0 : (job.recoveryStalls ?? 0) + 1;
    const delay = stalls ? delayFor(stalledDelays, stalls - 1) : 0;
    await completeRecognition(job, fields, {
      ...(missing.length
        ? { nextStage: stage + 1, nextReadAt: new Date(Date.now() + delay) }
        : {}),
      stalls,
      conflicts,
    });
  } catch (error) {
    // Only positive evidence about this source can end automatic recovery.
    // Missing objects are final; outages, auth/config and native crashes can recover.
    const now = new Date();
    if (
      error instanceof WrongDocumentKindError ||
      error instanceof InvalidDocumentError
    ) {
      const reason =
        error instanceof WrongDocumentKindError ? "wrong-kind" : "invalid";
      await failRead(job, error.message, reason, now);
    } else if (
      !runningEngine &&
      error instanceof Error &&
      error.name === "NoSuchKey"
    ) {
      await failRead(job, originalFileMissing, "invalid", now);
    } else {
      await failRead(
        job,
        documentUnreadable,
        runningEngine ? "engine" : "storage",
        now,
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
}
