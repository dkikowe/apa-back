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
    notes: String,
    lastNameLatin: String,
    firstNameLatin: String,
    birthDate: String,
    region: String,
    village: String,
    phone: String,
    phoneNormalized: String,
    iin: String,
    iinKey: String,
    documentNumber: String,
    issuedBy: String,
    issueDate: String,
    expiryDate: String,
    importKey: String,
    searchTokens: [String],
    identityDocumentId: { type: Schema.Types.ObjectId, ref: "Document" },
    archivedAt: { type: Date, default: null },
  },
  options,
);
participant.index({ iinKey: 1 }, { unique: true, sparse: true });
participant.index({ archivedAt: 1, region: 1, birthDate: 1 });
participant.index({ searchTokens: 1 });
participant.index({ importKey: 1 }, { unique: true, sparse: true });
participant.index({ phoneNormalized: 1 });
participant.index({ lastName: 1, firstName: 1 });
const paymentCategory = new Schema(
  {
    name: { type: String, required: true },
    nameKey: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
  },
  options,
);
const payment = new Schema(
  {
    participantId: {
      type: Schema.Types.ObjectId,
      ref: "Participant",
      required: true,
    },
    year: Number,
    paymentKind: {
      type: String,
      enum: ["membership", "additional"],
      default: "membership",
    },
    paymentCategoryId: { type: Schema.Types.ObjectId, ref: "PaymentCategory" },
    paymentCategoryName: String,
    amount: Number,
    paymentDate: String,
    paymentTime: { type: String, default: "" },
    receiptType: {
      type: String,
      enum: ["", "personal", "urshyk"],
      default: "",
    },
    receiptText: { type: String, default: "" },
    recipientName: String,
    payerName: { type: String, default: "" },
    receiptNumber: String,
    receiptNumberKey: String,
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
payment.index({ receiptNumberKey: 1 }, { unique: true, sparse: true });
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
    uploadHash: String,
    recognitionKey: String,
    recognitionVersion: Number,
    duplicate: Schema.Types.Mixed,
    ownerId: Schema.Types.ObjectId,
    participantId: Schema.Types.ObjectId,
    originalName: String,
    status: {
      type: String,
      enum: ["queued", "processing", "done", "failed", "duplicate"],
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
document.index({ uploadHash: 1 }, { unique: true, sparse: true });
document.index({ recognitionKey: 1 }, { unique: true, sparse: true });
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
export const PaymentCategory = mongoose.model(
  "PaymentCategory",
  paymentCategory,
);
export const Payment = mongoose.model("MembershipPayment", payment);
export const Finance = mongoose.model("FinancialTransaction", finance);
export const Document = mongoose.model("Document", document);
export const Audit = mongoose.model("AuditLog", audit);
const importDraft = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, required: true },
    rows: [Schema.Types.Mixed],
    status: { type: String, default: "preview" },
    result: Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  options,
);
importDraft.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ImportDraft = mongoose.model("ImportDraft", importDraft);
export async function connect() {
  await mongoose.connect((await import("./config.js")).config.mongo);
  await Promise.all(
    [
      Admin,
      Participant,
      Payment,
      PaymentCategory,
      Finance,
      Document,
      Audit,
      ImportDraft,
    ].map((m) => m.init()),
  );
}
