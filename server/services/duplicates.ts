import {
  IDENTITY_RECOGNITION_VERSION,
  RECEIPT_RECOGNITION_VERSION,
  missingDocumentFields,
} from "../../shared/document-recognition.js";
import type mongoose from "mongoose";
import { Document, Participant, Payment } from "../models.js";

import { documentErrorMessage } from "./document-errors.js";

export const receiptKey = (value: unknown) =>
  typeof value === "string"
    ? value.normalize("NFKC").replace(/\s/g, "").toUpperCase()
    : "";
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
  const p = await Participant.findById(pay.participantId)
    .session(session || null)
    .lean();
  return {
    message: `Бұл чек бұрын тіркелген${name(p) ? `: ${name(p)}` : ""}. Қайта қосуға болмайды.`,
    participantId: String(pay.participantId),
    paymentId: String(pay._id),
  };
}
// Uploads are drafts until a participant/payment actually references them.
// Merely reading a document must not reserve its IIN or receipt number.
export async function savedDocumentConflict(
  doc: any,
): Promise<DuplicateInfo | null> {
  const bound =
    doc.kind === "receipt"
      ? await Payment.findOne({ receiptDocumentId: doc._id }).lean()
      : await Participant.findOne({ identityDocumentId: doc._id }).lean();
  if (bound)
    return {
      message: "Бұл құжат сақталған жазбаға тіркелген. Қайта қосуға болмайды.",
      participantId: String(
        doc.kind === "receipt" ? (bound as any).participantId : bound._id,
      ),
      ...(doc.kind === "receipt" ? { paymentId: String(bound._id) } : {}),
    };
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
  const version =
    doc.kind === "identity"
      ? IDENTITY_RECOGNITION_VERSION
      : RECEIPT_RECOGNITION_VERSION;
  if (
    (doc.kind === "identity" || doc.kind === "receipt") &&
    doc.status === "done" &&
    (doc.recognitionVersion || 0) < version &&
    missingDocumentFields(doc.kind, doc.fields || {}).length
  ) {
    return (
      (await Document.findOneAndUpdate(
        {
          _id: doc._id,
          status: "done",
          participantId: null,
          $or: [
            { recognitionVersion: { $exists: false } },
            { recognitionVersion: { $lt: version } },
          ],
        },
        { $set: { status: "queued" }, $unset: { error: 1 } },
        { new: true },
      ).lean()) ||
      (await Document.findById(doc._id).lean()) ||
      doc
    );
  }
  return doc;
}
export function uploadResult(doc: any, reused = false) {
  return {
    id: doc._id,
    status: doc.status,
    fields: doc.fields || {},
    error: documentErrorMessage(doc.error),
    attempts: doc.attempts,
    reused,
  };
}
export async function recognitionConflict(
  doc: any,
  fields: Record<string, unknown>,
): Promise<DuplicateInfo | null> {
  const boundParticipant =
    doc.kind === "identity"
      ? await Participant.findOne({ identityDocumentId: doc._id }).lean()
      : null;
  const boundPayment =
    doc.kind === "receipt"
      ? await Payment.findOne({ receiptDocumentId: doc._id }).lean()
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
        )
      : await paymentConflict(
          number,
          doc.hash,
          boundPayment ? String(boundPayment._id) : undefined,
        );
  return conflict;
}

export async function completeRecognition(
  doc: any,
  fields: Record<string, unknown>,
) {
  const conflict = await recognitionConflict(doc, fields);
  if (conflict) {
    await Document.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "duplicate",
          fields,
          error: conflict.message,
          duplicate: conflict,
          completedAt: new Date(),
          recognitionVersion:
            doc.kind === "identity"
              ? IDENTITY_RECOGNITION_VERSION
              : RECEIPT_RECOGNITION_VERSION,
        },
        $unset: { recognitionKey: 1 },
      },
    );
    return;
  }
  await Document.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: "done",
        fields,
        completedAt: new Date(),
        recognitionVersion:
          doc.kind === "identity"
            ? IDENTITY_RECOGNITION_VERSION
            : RECEIPT_RECOGNITION_VERSION,
      },
      $unset: { error: 1, duplicate: 1, recognitionKey: 1 },
    },
  );
}
