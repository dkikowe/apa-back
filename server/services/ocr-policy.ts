export const receiptInsteadOfIdentity =
  "Куәліктің орнына чек жүктелген. Жеке куәлікті таңдаңыз. Чекті «Төлем қосу» бөлімінде жүктеңіз.";
export const identityInsteadOfReceipt =
  "Чектің орнына жеке куәлік жүктелген. Төлем чегін таңдаңыз.";
export class WrongDocumentKindError extends Error {
  constructor(expected: "identity" | "receipt" = "identity") {
    super(
      expected === "receipt"
        ? identityInsteadOfReceipt
        : receiptInsteadOfIdentity,
    );
    this.name = "WrongDocumentKindError";
  }
}
export const OCR_LAST_ROUND = 2;
