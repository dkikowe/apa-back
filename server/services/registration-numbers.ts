import mongoose, { type ClientSession } from "mongoose";
import { Participant } from "../models.js";

const Counter = mongoose.model(
  "RegistrationCounter",
  new mongoose.Schema(
    {
      _id: String,
      lastNumber: { type: Number, required: true },
    },
    { versionKey: false },
  ),
);
const counterId = "participant";

export async function reserveRegistrationNumbers(
  count: number,
  session?: ClientSession | null,
) {
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId, lastNumber: { $lte: Number.MAX_SAFE_INTEGER - count } },
    { $inc: { lastNumber: count } },
    { new: true, upsert: true, session },
  ).lean();
  return counter.lastNumber - count + 1;
}

const unnumbered = {
  registrationNumber: null,
  deletedAt: null,
  siteHiddenAt: null,
};

export async function backfillRegistrationNumbers() {
  // During a rolling deployment an older instance can still create an
  // unnumbered participant. Usually this indexed probe is the only DB call.
  if (!(await Participant.exists(unnumbered))) return;
  for (const archivedAt of [null, { $ne: null }]) {
    const filter = { ...unnumbered, archivedAt };
    let count;
    do {
      count = await mongoose.connection.transaction(async (session) => {
        const batch = await Participant.find(filter)
          .sort({ createdAt: 1, _id: 1 })
          .limit(250)
          .select({ _id: 1 })
          .session(session)
          .lean();
        if (!batch.length) return 0;
        const start = await reserveRegistrationNumbers(batch.length, session);
        // Normal writes treat the number as immutable. The migration sets it
        // only when absent, without modifying the profile or its updatedAt.
        await Participant.collection.bulkWrite(
          batch.map(({ _id }, i) => ({
            updateOne: {
              filter: { _id, ...filter },
              update: { $set: { registrationNumber: start + i } },
            },
          })),
          { session },
        );
        return batch.length;
      });
    } while (count === 250);
  }
}

export async function initializeRegistrationNumbers() {
  const largest = await Participant.findOne({
    registrationNumber: { $type: "number" },
  })
    .sort({ registrationNumber: -1 })
    .select("registrationNumber")
    .lean();
  await Counter.updateOne(
    { _id: counterId },
    { $max: { lastNumber: largest?.registrationNumber ?? 0 } },
    { upsert: true },
  );
  await backfillRegistrationNumbers();
}
