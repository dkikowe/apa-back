import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const replica = await MongoMemoryReplSet.create({
  binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY, version: "8.0.4" },
  replSet: { count: 1 },
});
try {
  process.env.MONGODB_URI = replica.getUri("isolated_performance_test");
  const { connect, Participant, Payment } = await import("../server/models.js");
  const { normalizeParticipant, listMembers, filtersSchema } =
    await import("../server/services/members.js");
  const { statistics, makeReport } =
    await import("../server/services/reports.js");
  const { REGIONS } = await import("../shared/domain.js");
  await connect();
  const participants = await Participant.insertMany(
    Array.from({ length: 20000 }, (_, i) =>
      normalizeParticipant({
        lastName: `Сынақ${String(i).padStart(5, "0")}`,
        firstName: "Үлгі",
        middleName: "",
        birthDate: `${1950 + (i % 55)}-05-15`,
        region: REGIONS[i % 7],
        phone: `+7 000 ${String(i).padStart(7, "0")}`,
      }),
    ),
  );
  await Payment.insertMany(
    participants
      .filter((_, i) => i % 3 !== 0)
      .map((p, i) => ({
        participantId: p._id,
        year: 2026,
        amount: i % 2 ? 109000 : 648700,
        paymentDate: "2026-05-10",
        voidedAt: null,
      })),
  );
  const result: Record<string, number> = {
    participants: 20000,
    payments: 13333,
  };
  const measure = async (label: string, fn: () => Promise<any>) => {
    const started = performance.now();
    const value = await fn();
    result[label] = Math.round(performance.now() - started);
    return value;
  };
  const filters = filtersSchema.parse({ year: 2026 });
  const page = await measure("listMs", () => listMembers(filters));
  assert.equal(page.total, 20000);
  assert.equal(page.items.length, 20);
  const filtered = await measure("combinedFilterMs", () =>
    listMembers(
      filtersSchema.parse({
        year: 2026,
        region: "Ақтау",
        age: "1",
        status: "partial",
      }),
    ),
  );
  assert.ok(filtered.total > 0);
  const summary = await measure("dashboardMs", () => statistics(filters));
  assert.equal(summary.totals.count, 20000);
  const report = await measure("xlsx20000Ms", () =>
    makeReport("members", filters),
  );
  assert.ok(report.byteLength > 100000);
  await mkdir(".local", { recursive: true });
  await writeFile(".local/benchmark.json", JSON.stringify(result, null, 2));
  console.info(JSON.stringify(result));
} finally {
  await mongoose.disconnect();
  await replica.stop();
}
