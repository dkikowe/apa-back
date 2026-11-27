import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { Document } from "../server/models.js";
import {
  claimRead,
  processRead,
  reclaimInterruptedRead,
  wakeOutdatedIdentityReads,
} from "../server/services/recognition-jobs.js";
import { resumeDraft, readerVersion } from "../server/services/duplicates.js";
import { documentUnreadable } from "../server/services/document-errors.js";
import {
  WrongDocumentKindError,
  InvalidDocumentError,
} from "../server/services/ocr-policy.js";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY || undefined },
  });
  await mongoose.connect(mongo.getUri("recovery_queue"));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Document.deleteMany({});
});
const load = async () => Buffer.from("synthetic test fixture");
const receipt = {
  amount: 160000,
  paymentDate: "2026-11-26",
  paymentTime: "17:16",
  recipientName: "Сынақ А.",
  payerName: "Үлгі Б.",
  method: "Kaspi Gold",
  receiptNumber: "TEST-01",
};
const fixture = { kind: "receipt", mime: "image/png", key: "test" };
it("gives delayed IIN or Latin-name reads one immediate retry on a new reader version", async () => {
  const now = new Date();
  const later = new Date(+now + 86400000);
  const version = readerVersion("identity");
  const old = {
    kind: "identity",
    status: "queued",
    recoveryStage: 8,
    recoveryConflicts: ["iin"],
    fields: { firstName: "Сынақ" },
    recoveryHasCheckpoint: true,
    recognitionVersion: version - 1,
    nextReadAt: later,
  };
  const [waiting, waitingForLatin] = await Document.create([
    old,
    { ...old, fields: { iin: "000000000001", lastName: "Сынақ" } },
    { ...old, kind: "receipt" },
    { ...old, recognitionVersion: version },
    { ...old, status: "processing" },
    {
      ...old,
      fields: {
        iin: "000000000002",
        firstNameLatin: "FIRST",
        lastNameLatin: "LAST",
      },
    },
  ]);
  expect((await wakeOutdatedIdentityReads(now)).modifiedCount).toBe(2);
  expect(await Document.findById(waitingForLatin._id).lean()).toMatchObject({
    nextReadAt: now,
    recognitionVersion: version,
  });
  expect(await Document.findById(waiting._id).lean()).toMatchObject({
    fields: old.fields,
    recoveryStage: 8,
    recoveryConflicts: ["iin"],
    nextReadAt: now,
    recognitionVersion: version,
  });
  await Document.updateOne(
    { _id: waiting._id },
    { $set: { nextReadAt: later } },
  );
  expect((await wakeOutdatedIdentityReads(now)).modifiedCount).toBe(0);
});
it("checkpoints partial reads, yields to a waiting job, and stops immediately on completion", async () => {
  const original = await Document.create(fixture);
  const first = (await claimRead())!;
  const another = await Document.create(fixture);
  await processRead(first, load, async (_b, _m, _k, options) => {
    expect(options?.recoveryStage).toBe(0);
    return { amount: receipt.amount };
  });
  const saved = await Document.findById(original._id);
  expect(saved?.toObject()).toMatchObject({
    status: "queued",
    recoveryStage: 1,
    attempts: 1,
    fields: { amount: receipt.amount },
  });
  const second = (await claimRead())!;
  expect(String(second._id)).toBe(String(another._id));
  await processRead(second, load, async () => receipt);
  const next = (await claimRead())!;
  await processRead(next, load, async (_b, _m, _k, options) => {
    expect(options?.recoveryStage).toBe(1);
    expect(options?.previousFields).toEqual({ amount: receipt.amount });
    return receipt;
  });
  expect(await Document.findById(original._id).lean()).toMatchObject({
    status: "done",
    attempts: 1,
    fields: receipt,
  });
  expect(await claimRead()).toBeNull();
});
it.each(["identity", "receipt"] as const)(
  "keeps %s checkpoints beyond the fast rounds, backs off on stalls, and accelerates on verified progress",
  async (kind) => {
    const doc = await Document.create({ ...fixture, kind });
    const complete: Record<string, string | number> =
      kind === "receipt"
        ? receipt
        : {
            firstName: "Үлгі",
            lastName: "Сынақ",
            firstNameLatin: "ULGI",
            lastNameLatin: "SYNAQ",
            birthDate: "1990-01-01",
            iin: "900101000011",
            issuedBy: "ҚР ІШКІ ІСТЕР МИНИСТРЛІГІ",
            documentNumber: "123456789",
            issueDate: "2020-01-01",
            expiryDate: "2030-01-01",
          };
    const late = kind === "receipt" ? "recipientName" : "issuedBy";
    const last = kind === "receipt" ? "method" : "documentNumber";
    const initial = { ...complete };
    delete initial[late];
    delete initial[last];
    let due = new Date();
    for (let stage = 0; stage <= 12; stage++) {
      const job = (await claimRead(due))!;
      expect(String(job._id)).toBe(String(doc._id));
      const before = Date.now();
      await processRead(job, load, async (_b, _m, _k, options) => {
        expect(options?.recoveryStage).toBe(stage);
        if (stage > 0)
          expect(options?.previousFields).toEqual(
            stage === 12 ? { ...initial, [late]: complete[late] } : initial,
          );
        if (stage === 12) return complete;
        if (stage === 11) return { ...initial, [late]: complete[late] };
        return initial;
      });
      const saved = (await Document.findById(doc._id).lean())!;
      expect(saved.attempts).toBe(1);
      if (stage === 12) {
        expect(saved).toMatchObject({ status: "done", fields: complete });
        expect(saved.nextReadAt).toBeUndefined();
      } else {
        expect(saved).toMatchObject({
          status: "queued",
          recoveryStage: stage + 1,
        });
        due = saved.nextReadAt!;
        if (stage >= 4 && stage < 11) {
          expect(+due - before).toBeGreaterThanOrEqual(10_000);
          expect(await claimRead(new Date(+due - 1))).toBeNull();
          if (stage === 10)
            expect(+due - before).toBeGreaterThanOrEqual(86_400_000);
        } else {
          expect(+due).toBeLessThanOrEqual(Date.now());
        }
      }
    }
    expect(await claimRead()).toBeNull();
  },
);

it("keeps an ambiguous identifier withheld even while an unreadable source remains queued", async () => {
  const doc = await Document.create({ ...fixture, kind: "identity" });
  let due = new Date();
  for (let stage = 0; stage < 7; stage++) {
    await processRead(
      (await claimRead(due))!,
      load,
      async (_b, _m, _k, options) => {
        if (!stage) options?.conflicts?.push("iin");
        else expect(options?.conflicts).toEqual(["iin"]);
        return { firstName: "Үлгі" };
      },
    );
    const saved = (await Document.findById(doc._id).lean())!;
    expect(saved).toMatchObject({
      status: "queued",
      fields: { firstName: "Үлгі" },
      recoveryConflicts: ["iin"],
    });
    expect(saved.fields.iin).toBeUndefined();
    due = saved.nextReadAt!;
  }
});

it("gives both new uploads and overdue recoveries a turn", async () => {
  const due = new Date(Date.now() - 60_000);
  const old = await Document.create({
    ...fixture,
    recoveryStage: 9,
    nextReadAt: due,
    updatedAt: due,
  });
  const fresh = await Document.create(fixture);
  expect(String((await claimRead())?._id)).toBe(String(fresh._id));
  await Document.create(fixture);
  expect(String((await claimRead(new Date(), true))?._id)).toBe(
    String(old._id),
  );
});
it("resumes after storage failures and expired workers; stale results cannot overwrite a takeover", async () => {
  const doc = await Document.create(fixture);
  const start = new Date();
  const stale = (await claimRead(start))!;
  const future = (minutes: number) =>
    new Date(start.getTime() + minutes * 60_000);
  await reclaimInterruptedRead(future(12));
  const takeover = (await claimRead(future(13)))!;
  expect(takeover.readLease).not.toEqual(stale.readLease);
  await processRead(stale, load, async () => ({ receiptNumber: "STALE" }));
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "processing",
    readLease: takeover.readLease,
  });
  await processRead(
    takeover,
    async () => {
      throw new Error("storage temporarily unavailable");
    },
    async () => receipt,
  );
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "queued",
    recoveryFailures: 2,
  });
  const final = (await claimRead(future(14)))!;
  await processRead(final, load, async () => receipt);
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "done",
    attempts: 1,
    fields: receipt,
  });
});
it("never retries the wrong document kind; upgrades an old transiently failed draft once", async () => {
  const wrong = await Document.create({ ...fixture, kind: "identity" });
  await processRead((await claimRead())!, load, async () => {
    throw new WrongDocumentKindError();
  });
  expect(await Document.findById(wrong._id).lean()).toMatchObject({
    status: "failed",
    attempts: 1,
  });
  expect(await claimRead()).toBeNull();
  const failed = await Document.create({
    ...fixture,
    status: "failed",
    error: documentUnreadable,
    recognitionVersion: 1,
    attempts: 3,
  });
  expect(await resumeDraft(failed)).toMatchObject({
    status: "queued",
    recoveryStage: 0,
    recognitionVersion: readerVersion("receipt"),
  });
  let due = new Date();
  for (let i = 0; i < 8; i++) {
    await processRead(
      (await claimRead(due))!,
      async () => {
        throw Error("offline");
      },
      async () => receipt,
    );
    const paused = (await Document.findById(failed._id).lean())!;
    expect(paused).toMatchObject({
      status: "queued",
      attempts: 4,
      recoveryStage: 0,
      recoveryFailures: i + 1,
    });
    expect(+paused.nextReadAt!).toBeGreaterThan(Date.now());
    due = paused.nextReadAt!;
  }
  await processRead((await claimRead(due))!, load, async () => receipt);
  expect(await Document.findById(failed._id).lean()).toMatchObject({
    status: "done",
    attempts: 4,
    fields: receipt,
  });
});

it("uses a different strategy after repeated native crashes without erasing checkpoints or treating them as complete", async () => {
  const doc = await Document.create({
    ...fixture,
    fields: { recipientName: "Old cached guess" },
  });
  const fail = async () => {
    throw Error("simulated stalled engine");
  };
  await processRead((await claimRead())!, load, fail);
  const future = () => new Date(Date.now() + 60_000);
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    fields: { recipientName: "Old cached guess" },
    recoveryHasCheckpoint: false,
  });
  const next = (await claimRead(future()))!;
  expect(next.recoveryStage).toBe(1);
  await processRead(next, load, async (_b, _m, _k, options) => {
    expect(options?.previousFields).toEqual({});
    return { amount: receipt.amount };
  });
  let due = new Date();
  for (let i = 0; i < 5; i++) {
    await processRead((await claimRead(due))!, load, fail);
    const paused = (await Document.findById(doc._id).lean())!;
    expect(paused).toMatchObject({
      status: "queued",
      attempts: 1,
      fields: { amount: receipt.amount },
      recoveryStage: i + 3,
    });
    due = paused.nextReadAt!;
  }
  await processRead(
    (await claimRead(due))!,
    load,
    async (_b, _m, _k, options) => {
      expect(options?.previousFields).toEqual({ amount: receipt.amount });
      return receipt;
    },
  );
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "done",
    attempts: 1,
    fields: receipt,
  });
});

it("moves to a different strategy if worker restarts repeatedly interrupt the same stage", async () => {
  const doc = await Document.create(fixture);
  const start = Date.now();
  for (let i = 0; i < 2; i++) {
    const now = start + i * 300_000;
    expect((await claimRead(new Date(now)))?._id).toEqual(doc._id);
    await reclaimInterruptedRead(new Date(now + 120_000));
  }
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "queued",
    recoveryStage: 1,
    recoveryFailures: 2,
    attempts: 1,
  });
});

it("stops confirmed invalid sources and missing original objects without requeueing them", async () => {
  for (const failure of ["invalid", "missing"] as const) {
    const doc = await Document.create(fixture);
    const loadSrc =
      failure === "invalid"
        ? load
        : async () => {
            throw Object.assign(new Error(), { name: "NoSuchKey" });
          };
    await processRead((await claimRead())!, loadSrc, async () => {
      throw new InvalidDocumentError();
    });
    expect(await Document.findById(doc._id).lean()).toMatchObject({
      status: "failed",
      permanentReadFailure: true,
      wrongDocumentKind: false,
    });
  }
  expect(await claimRead(new Date(Date.now() + 86_400_000))).toBeNull();
});
