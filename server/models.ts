import mongoose, { Schema } from "mongoose";
const options = { timestamps: true };
const admin = new Schema(
  {
    username: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
  },
  options,
);
const participant = new Schema(
  {
    lastName: String,
    firstName: String,
    middleName: String,
    lastNameLatin: String,
    firstNameLatin: String,
    birthDate: String,
    region: String,
    phone: String,
    phoneNormalized: String,
    searchTokens: [String],
    identityDocumentId: { type: Schema.Types.ObjectId, ref: "Document" },
    archivedAt: { type: Date, default: null },
  },
  options,
);
participant.index({ archivedAt: 1, region: 1, birthDate: 1 });
participant.index({ searchTokens: 1 });
participant.index({ phoneNormalized: 1 });
participant.index({ lastName: 1, firstName: 1 });
const payment = new Schema(
  {
    participantId: {
      type: Schema.Types.ObjectId,
      ref: "Participant",
      required: true,
    },
    year: Number,
    amount: Number,
    paymentDate: String,
    recipientName: String,
    receiptNumber: String,
    method: String,
    receiptDocumentId: { type: Schema.Types.ObjectId, ref: "Document" },
    fileHash: String,
    fingerprint: String,
    duplicateConfirmed: Boolean,
    dedupeKeys: { type: [String], default: undefined },
    notes: String,
    voidedAt: { type: Date, default: null },
  },
  options,
);
payment.index({ participantId: 1, year: 1, voidedAt: 1 });
payment.index({ paymentDate: 1, voidedAt: 1 });
payment.index({ year: 1, voidedAt: 1 });
payment.index({ dedupeKeys: 1 }, { unique: true, sparse: true });
payment.index({ fileHash: 1 });
payment.index({ fingerprint: 1 });
const finance = new Schema(
  {
    type: { type: String, enum: ["income", "expense"] },
    amount: Number,
    date: String,
    category: String,
    description: String,
    voidedAt: { type: Date, default: null },
  },
  options,
);
finance.index({ date: 1, voidedAt: 1 });
const document = new Schema(
  {
    kind: { type: String, enum: ["identity", "receipt"] },
    key: String,
    mime: String,
    size: Number,
    hash: String,
    ownerId: Schema.Types.ObjectId,
    participantId: Schema.Types.ObjectId,
    originalName: String,
    status: {
      type: String,
      enum: ["queued", "processing", "done", "failed"],
      default: "queued",
    },
    fields: Schema.Types.Mixed,
    error: String,
    startedAt: Date,
    completedAt: Date,
    attempts: { type: Number, default: 0 },
  },
  options,
);
document.index({ status: 1, createdAt: 1 });
document.index({ hash: 1 });
const audit = new Schema(
  {
    adminId: Schema.Types.ObjectId,
    action: String,
    entity: String,
    entityId: Schema.Types.ObjectId,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
  },
  options,
);
audit.index({ createdAt: -1 });
export const Admin = mongoose.model("Admin", admin);
export const Participant = mongoose.model("Participant", participant);
export const Payment = mongoose.model("MembershipPayment", payment);
export const Finance = mongoose.model("FinancialTransaction", finance);
export const Document = mongoose.model("Document", document);
export const Audit = mongoose.model("AuditLog", audit);
export async function connect() {
  await mongoose.connect((await import("./config.js")).config.mongo);
  await Promise.all(
    [Admin, Participant, Payment, Finance, Document, Audit].map((m) =>
      m.init(),
    ),
  );
}
