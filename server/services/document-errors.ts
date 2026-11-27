import {
  identityInsteadOfReceipt,
  receiptInsteadOfIdentity,
} from "./ocr-policy.js";

export const readingInterrupted = "Құжатты оқу аяқталмады.";
export const documentUnreadable = "Құжат оқылмады.";
export const originalFileMissing =
  "Түпнұсқа файл табылмады. Құжатты қайта жүктеңіз.";

// Earlier worker versions stored extra instructions after the status.
// Normalize only those historical messages when returning a saved document.
export function documentErrorMessage(error: string | null | undefined) {
  if (error?.startsWith(readingInterrupted + " Қолмен "))
    return readingInterrupted;
  if (error?.startsWith(documentUnreadable + " Мәліметтерді қолмен "))
    return documentUnreadable;
  return error;
}

export function documentReadState(doc: {
  status?: string | null;
  error?: string | null;
  wrongDocumentKind?: boolean | null;
  permanentReadFailure?: boolean | null;
}) {
  return {
    error: documentErrorMessage(doc.error),
    permanentReadFailure: doc.permanentReadFailure === true,
    wrongDocumentKind:
      doc.status === "failed" &&
      (doc.wrongDocumentKind === true ||
        doc.error === receiptInsteadOfIdentity ||
        doc.error === identityInsteadOfReceipt),
  };
}
