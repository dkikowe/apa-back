export class WrongDocumentKindError extends Error {
  constructor() {
    super(
      "Куәліктің орнына чек жүктелген. Жеке куәлікті таңдаңыз. Чекті «Төлем қосу» бөлімінде жүктеңіз.",
    );
    this.name = "WrongDocumentKindError";
  }
}
export const OCR_LAST_ROUND = 2;
