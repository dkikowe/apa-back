import {
  IDENTITY_RECOGNITION_VERSION,
  RECEIPT_RECOGNITION_VERSION,
  missingDocumentFields,
  receiptKey,
} from "../../shared/document-recognition.js";
import type mongoose from "mongoose";
import { Document, Participant, Payment } from "../models.js";

import {
  documentErrorMessage,
  documentReadState,
  documentUnreadable,
  readingInterrupted,
} from "./document-errors.js";

export { receiptKey } from "../../shared/document-recognition.js";
const receiptPattern = (value: string) =>
  new RegExp(
    "^\\s*" +
      [...receiptKey(value)]
        .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s*") +
      "\\s*$",
    "i",
  );
export type DuplicateInfo = {
  message: string;
  participantId?: string;
  paymentId?: string;
  duplicateDocumentId?: string;
  canReuse?: boolean;
};
export class DuplicateError extends Error {
  status = 409;
  constructor(public details: DuplicateInfo) {
    super(details.message);
  }
}
const name = (p: any) => [p?.lastName, p?.firstName].filter(Boolean).join(" ");
export async function participantConflict(
  iin: string,
  except?: string,
  session?: mongoose.ClientSession,
) {
  if (!iin) return null;
  const p = await Participant.findOne({
    deletedAt: null,
    iin,
    ...(except ? { _id: { $ne: except } } : {}),
  })
    .session(session || null)
    .lean();
  return p
    ? {
        message: `Бұл ЖСН бұрын тіркелген: ${name(p) || "қатысушы"}. Қайта қосуға болмайды.`,
        participantId: String(p._id),
      }
    : null;
}
export async function paymentConflict(
  number: string,
  fileHash?: string,
  except?: string,
  session?: mongoose.ClientSession,
) {
  const key = receiptKey(number);
  const alternatives: any[] = [
    ...(key
      ? [{ receiptNumberKey: key }, { receiptNumber: receiptPattern(number) }]
      : []),
    ...(fileHash ? [{ fileHash }] : []),
  ];
  if (!alternatives.length) return null;
  const pay = await Payment.findOne({
    ...(except ? { _id: { $ne: except } } : {}),
    $or: alternatives,
  })
    .session(session || null)
    .lean();
  if (!pay) return null;
  return savedPaymentConflict(pay, session);
}

export async function savedPaymentConflict(
  pay: { _id: mongoose.Types.ObjectId; participantId: mongoose.Types.ObjectId },
  session?: mongoose.ClientSession,
): Promise<DuplicateInfo> {
  const p = await Participant.findOne({
    _id: pay.participantId,
    deletedAt: null,
  })
    .select("lastName firstName")
    .session(session || null)
    .lean();
  return {
    message: `Бұл чек бұрын тіркелген${name(p) ? `: ${name(p)}` : ""}. Қайта қосуға болмайды.`,
    ...(p ? { participantId: String(p._id) } : {}),
    paymentId: String(pay._id),
  };
}
// A cached duplicate may outlive the participant it linked to. Recheck
// against current records before showing that link or refusing a save.
export async function currentDocumentDuplicate(
  doc: any,
  session?: mongoose.ClientSession,
) {
  const cached = doc.duplicate;
  const removed =
    cached?.participantId &&
    (await Participant.exists({
      _id: cached.participantId,
      deletedAt: { $ne: null },
    }).session(session || null));
  if (cached && !removed) return cached;
  return recognitionConflict(doc, doc.fields || {}, session);
}
// Uploads are drafts until a participant/payment actually references them.
// Merely reading a document must not reserve its IIN or receipt number.
export async function savedDocumentConflict(
  doc: any,
): Promise<DuplicateInfo | null> {
  if (doc.kind === "receipt") {
    const pay = await Payment.findOne({ receiptDocumentId: doc._id }).lean();
    if (pay) return savedPaymentConflict(pay);
  } else {
    const person = await Participant.findOne({
      identityDocumentId: doc._id,
      deletedAt: null,
    }).lean();
    if (person)
      return {
        message: "Бұл құжат сақталған жазбаға тіркелген.",
        participantId: String(person._id),
      };
  }
  return doc.kind === "receipt"
    ? paymentConflict(String(doc.fields?.receiptNumber || ""), doc.hash)
    : participantConflict(String(doc.fields?.iin || ""));
}
export async function resumeDraft(doc: any) {
  const conflict = await savedDocumentConflict(doc);
  if (conflict) throw new DuplicateError(conflict);
  // Recover old drafts incorrectly marked duplicate of another unsaved upload.
  if (doc.status === "duplicate" && !doc.participantId) {
    const updated = await Document.findOneAndUpdate(
      { _id: doc._id, participantId: null, status: "duplicate" },
      {
        $set: { status: "done" },
        $unset: { duplicate: 1, error: 1, recognitionKey: 1 },
      },
      { new: true },
    ).lean();
    if (updated) return resumeDraft(updated);
    const current = await Document.findById(doc._id).lean();
    if (current) {
      const conflict = await savedDocumentConflict(current);
      if (conflict) throw new DuplicateError(conflict);
      return current;
    }
  }
  // Reusing an old partial scan should run the improved reader once, rather
  // than returning its incomplete cached fields forever. Saved attachments
  // are excluded by savedDocumentConflict above.
  const version = readerVersion(doc.kind);
  if (needsReaderUpgrade(doc)) {
    return (
      (await Document.findOneAndUpdate(
        {
          _id: doc._id,
          status: doc.status,
          participantId: null,
          $or: [
            { recognitionVersion: { $exists: false } },
            { recognitionVersion: { $lt: version } },
          ],
        },
        {
          $set: { ...newReadCycle, recognitionVersion: version },
          $unset: { error: 1 },
        },
        { new: true },
      ).lean()) ||
      (await Document.findById(doc._id).lean()) ||
      doc
    );
  }
  return doc;
}
// Manual retries and version upgrades start a fresh reader cycle. Saved fields
// stay available while the new job is running; only stages within the new
// cycle carry OCR guesses forward.
export const newReadCycle = {
  status: "queued",
  recoveryStage: 0,
  wrongDocumentKind: false,
  recoveryFailures: 0,
  recoveryConflicts: [],
  nextReadAt: null,
  readLease: null,
  leaseUntil: null,
};

export function readerVersion(kind?: string | null) {
  return kind === "identity"
    ? IDENTITY_RECOGNITION_VERSION
    : RECEIPT_RECOGNITION_VERSION;
}

export function needsReaderUpgrade(doc: {
  kind?: string | null;
  status?: string | null;
  fields?: Record<string, unknown>;
  recognitionVersion?: number | null;
  error?: string | null;
}) {
  if (
    (doc.kind !== "identity" && doc.kind !== "receipt") ||
    (doc.recognitionVersion ?? 0) >= readerVersion(doc.kind)
  )
    return false;
  if (doc.status === "failed") {
    const error = documentErrorMessage(doc.error);
    return error === readingInterrupted || error === documentUnreadable;
  }
  if (doc.status !== "done") return false;
  const fields = doc.fields || {};
  // The old personal-transfer reader could flatten printed ү/ұ into у even
  // when every field was present. Refresh these cached names on first reuse.
  const oldTransferName =
    doc.kind === "receipt" &&
    (doc.recognitionVersion ?? 0) < 7 &&
    fields.receiptType === "personal" &&
    /у/iu.test(String(fields.recipientName ?? ""));
  return oldTransferName || missingDocumentFields(doc.kind, fields).length > 0;
}
export function uploadResult(doc: any, reused = false) {
  return {
    id: doc._id,
    status: doc.status,
    fields: doc.fields || {},
    ...documentReadState(doc),
    attempts: doc.attempts,
    reused,
  };
}
export async function recognitionConflict(
  doc: any,
  fields: Record<string, unknown>,
  session?: mongoose.ClientSession,
): Promise<DuplicateInfo | null> {
  const boundParticipant =
    doc.kind === "identity"
      ? await Participant.findOne({
          identityDocumentId: doc._id,
          deletedAt: null,
        })
          .session(session || null)
          .lean()
      : null;
  const boundPayment =
    doc.kind === "receipt"
      ? await Payment.findOne({ receiptDocumentId: doc._id })
          .session(session || null)
          .lean()
      : null;
  const number =
    doc.kind === "identity"
      ? String(fields.iin || "")
      : String(fields.receiptNumber || "");
  const conflict =
    doc.kind === "identity"
      ? await participantConflict(
          number,
          boundParticipant ? String(boundParticipant._id) : undefined,
          session,
        )
      : await paymentConflict(
          number,
          doc.hash,
          boundPayment ? String(boundPayment._id) : undefined,
          session,
        );
  return conflict;
}

export async function completeRecognition(
  doc: any,
  fields: Record<string, unknown>,
  recovery?: { nextStage?: number; conflicts: string[] },
) {
  const conflict = await recognitionConflict(doc, fields);
  const filter = {
    _id: doc._id,
    ...(doc.readLease
      ? { status: "processing", readLease: doc.readLease }
      : {}),
  };
  const checkpoint = {
    fields,
    recognitionVersion: readerVersion(doc.kind),
    recoveryFailures: 0,
    recoveryConflicts: recovery?.conflicts ?? [],
  };
  const released = {
    readLease: 1,
    leaseUntil: 1,
    nextReadAt: 1,
    recognitionKey: 1,
  };
  if (!conflict && recovery?.nextStage !== undefined) {
    await Document.updateOne(filter, {
      $set: {
        ...checkpoint,
        status: "queued",
        recoveryStage: recovery.nextStage,
      },
      $unset: { ...released, completedAt: 1, duplicate: 1, error: 1 },
    });
    return;
  }
  await Document.updateOne(filter, {
    $set: {
      ...checkpoint,
      status: conflict ? "duplicate" : "done",
      completedAt: new Date(),
      ...(conflict ? { error: conflict.message, duplicate: conflict } : {}),
    },
    $unset: { ...released, ...(!conflict ? { error: 1, duplicate: 1 } : {}) },
  });
}
