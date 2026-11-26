import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { Document } from "../server/models.js";
import {
  claimRead,
  processRead,
  reclaimInterruptedRead,
} from "../server/services/recognition-jobs.js";
import { resumeDraft, readerVersion } from "../server/services/duplicates.js";
import { documentUnreadable } from "../server/services/document-errors.js";
import { WrongDocumentKindError } from "../server/services/ocr.js";

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
it("bounds fruitless refinements while keeping ambiguous identifiers withheld on subsequent rounds", async () => {
  const doc = await Document.create({ ...fixture, kind: "identity" });
  for (let stage = 0; stage < 3; stage++) {
    await processRead(
      (await claimRead())!,
      load,
      async (_b, _m, _k, options) => {
        expect(options?.recoveryStage).toBe(stage);
        if (!stage) options?.conflicts?.push("iin");
        else expect(options?.conflicts).toEqual(["iin"]);
        return { firstName: "Үлгі" };
      },
    );
  }
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "done",
    attempts: 1,
    fields: { firstName: "Үлгі" },
  });
  expect(await claimRead()).toBeNull();
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
  for (let i = 0; i < 3; i++)
    await processRead(
      (await claimRead(new Date(Date.now() + 60_000)))!,
      async () => {
        throw Error("offline");
      },
      async () => receipt,
    );
  expect(
    await resumeDraft(await Document.findById(failed._id).lean()),
  ).toMatchObject({ status: "failed", attempts: 4 });
  expect(await claimRead(new Date(Date.now() + 60_000))).toBeNull();
});

it("uses a different strategy after an engine crash and serves the last successful checkpoint on exhaustion", async () => {
  const doc = await Document.create({
    ...fixture,
    fields: { recipientName: "Old cached guess" },
  });
  const fail = async () => {
    throw Error("simulated stalled engine");
  };
  await processRead((await claimRead())!, load, fail);
  const future = () => new Date(Date.now() + 60_000);
  const next = (await claimRead(future()))!;
  expect(next.recoveryStage).toBe(1);
  await processRead(next, load, async (_b, _m, _k, options) => {
    expect(options?.previousFields).toEqual({});
    return { amount: receipt.amount };
  });
  for (let i = 0; i < 3; i++)
    await processRead((await claimRead(future()))!, load, fail);
  expect(await Document.findById(doc._id).lean()).toMatchObject({
    status: "done",
    attempts: 1,
    fields: { amount: receipt.amount },
  });
  expect(await claimRead(future())).toBeNull();
});
