import type mongoose from "mongoose";
import { Document, Participant, Payment } from "../models.js";

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
export async function documentConflictInfo(
  doc: any,
  ownerId?: unknown,
): Promise<DuplicateInfo> {
  return {
    message: "Бұл құжат бұрын жүктелген. Қайта жүктеуге болмайды.",
    duplicateDocumentId: String(doc._id),
    ...(doc.participantId ? { participantId: String(doc.participantId) } : {}),
    canReuse:
      !doc.participantId &&
      doc.status !== "duplicate" &&
      (!ownerId || String(doc.ownerId) === String(ownerId)),
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
  if (conflict) return conflict;
  // Re-reading an attachment of its existing record does not create a new upload.
  if (boundParticipant || boundPayment || !number) return null;
  const other = await Document.findOne({
    kind: doc.kind,
    status: "done",
    _id: { $ne: doc._id },
    [doc.kind === "identity" ? "fields.iin" : "fields.receiptNumber"]:
      doc.kind === "identity" ? number : receiptPattern(number),
  })
    .sort({ createdAt: 1 })
    .lean();
  return other ? documentConflictInfo(other, doc.ownerId) : null;
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
        },
        $unset: { recognitionKey: 1 },
      },
    );
    return;
  }
  const identifier =
    doc.kind === "identity"
      ? String(fields.iin || "")
      : receiptKey(fields.receiptNumber);
  try {
    await Document.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "done",
          fields,
          completedAt: new Date(),
          ...(!doc.participantId && identifier
            ? { recognitionKey: doc.kind + ":" + identifier }
            : {}),
        },
        $unset: {
          error: 1,
          duplicate: 1,
          ...(!identifier || doc.participantId ? { recognitionKey: 1 } : {}),
        },
      },
    );
  } catch (error: any) {
    if (error.code !== 11000) throw error;
    const other = await Document.findOne({
      recognitionKey: doc.kind + ":" + identifier,
      _id: { $ne: doc._id },
    }).lean();
    const duplicate = other
      ? await documentConflictInfo(other, doc.ownerId)
      : { message: "Бұл құжат бұрын тіркелген. Қайта қосуға болмайды." };
    await Document.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "duplicate",
          fields,
          error: duplicate.message,
          duplicate,
          completedAt: new Date(),
        },
        $unset: { recognitionKey: 1 },
      },
    );
  }
}
