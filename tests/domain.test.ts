import { describe, it, expect } from "vitest";
import {
  ageAt,
  ageGroup,
  balance,
  FEE,
  parseMoney,
  participantSchema,
} from "../shared/domain.js";
import {
  extractFields,
  extractIdentityLayout,
  type PositionedText,
} from "../server/services/ocr.js";
describe("Age and money", () => {
  it("calculates age on the birthday, not by a stored value", () => {
    expect(ageAt("2000-11-19", "2026-11-18")).toBe(25);
    expect(ageAt("2000-11-18", "2026-11-18")).toBe(26);
    expect(ageAt("2000-02-29", "2025-02-28")).toBe(24);
    expect(ageAt("2000-02-29", "2025-03-01")).toBe(25);
  });
  it.each([
    [24, 0],
    [25, 0],
    [26, 1],
    [44, 1],
    [45, 1],
    [46, 2],
    [64, 2],
    [65, 2],
    [66, 3],
    [90, 3],
  ])("groups age %i into %i", (age, group) =>
    expect(ageGroup(age)).toBe(group),
  );
  it("handles partial, full, zero and overpayments exactly in tiyn", () => {
    expect(balance(109000)).toMatchObject({
      remaining: 539700,
      status: "partial",
    });
    expect(balance(109000 + 539700)).toMatchObject({
      remaining: 0,
      status: "paid",
    });
    expect(balance(700000)).toMatchObject({
      overpayment: 51300,
      progress: 100,
    });
    expect(balance(0)).toMatchObject({ remaining: FEE, status: "unpaid" });
  });
  it("parses money without floating-point multiplication", () => {
    expect(parseMoney("6 487,15")).toBe(648715);
    expect(parseMoney("0.29")).toBe(29);
    expect(() => parseMoney("1.001")).toThrow();
    expect(() => parseMoney("-15")).toThrow();
  });
  it("rejects invalid calendar dates and future birthdays", () => {
    expect(
      participantSchema.safeParse({
        lastName: "Test",
        firstName: "Example",
        birthDate: "2026-02-30",
        region: "Ақтау",
        phone: "+70000000000",
      }).success,
    ).toBe(false);
  });
});
describe("Conservative OCR field extraction", () => {
  it("extracts labeled names and preserves original Latin spelling", () => {
    expect(
      extractFields(
        "ТЕГІ\nҮЛГІҚЫЗЫ\nАТЫ\nАЙГҮЛ\nТУҒАН КҮНІ\n15.04.1975\nSURNAME\nULGIKYZY\nGIVEN NAMES\nAIGUL",
        "identity",
      ),
    ).toMatchObject({
      lastName: "ҮЛГІҚЫЗЫ",
      firstName: "АЙГҮЛ",
      birthDate: "1975-04-15",
      lastNameLatin: "ULGIKYZY",
      firstNameLatin: "AIGUL",
    });
  });
  it("extracts receipt amount/date/recipient and transaction ID", () => {
    expect(
      extractFields(
        "СУММА ПЕРЕВОДА: 1 090,00 KZT\nДАТА: 18.11.2026\nПОЛУЧАТЕЛЬ: Сынақ ұйымы\nНОМЕР ЧЕКА: TEST-123",
        "receipt",
      ),
    ).toMatchObject({
      amount: 109000,
      paymentDate: "2026-11-18",
      recipientName: "Сынақ ұйымы",
      receiptNumber: "TEST-123",
    });
  });
  it("never invents missing fields or treats unrelated dates as birthdays", () => {
    expect(extractFields("NOT READABLE 01.01.2020", "identity")).toEqual({});
    expect(extractFields("No amount available", "receipt")).toEqual({});
  });
});

describe("OCR does not invent labels or truncate formatted money", () => {
  it("leaves missing names empty when the next line is another label", () => {
    expect(
      extractFields("ФАМИЛИЯ\nИМЯ\nДАТА РОЖДЕНИЯ\n18.11.1970", "identity"),
    ).toEqual({ birthDate: "1970-11-18" });
  });
  it("reads bilingual headings and keeps original Latin spelling", () => {
    expect(
      extractFields(
        "ТЕГІ / SURNAME\nҮЛГІҚЫЗЫ / ULGIKYZY\nАТЫ / NAME\nАЙГҮЛ / AIGUL\nТУҒАН КҮНІ / DATE OF BIRTH\n1975-04-15",
        "identity",
      ),
    ).toEqual({
      lastName: "ҮЛГІҚЫЗЫ",
      lastNameLatin: "ULGIKYZY",
      firstName: "АЙГҮЛ",
      firstNameLatin: "AIGUL",
      birthDate: "1975-04-15",
    });
  });
  it.each(["6 487,00", "6.487,00", "6,487.00", "6487.00", "6,487", "6.487"])(
    "reads %s as 6487 tenge",
    (value) => {
      expect(extractFields("TOTAL: " + value + " KZT", "receipt").amount).toBe(
        648700,
      );
    },
  );
  it("does not copy a following field into a missing recipient", () => {
    expect(extractFields("ПОЛУЧАТЕЛЬ\nНОМЕР ЧЕКА: 12345", "receipt")).toEqual({
      receiptNumber: "12345",
    });
  });
  it("rejects negative and malformed amounts rather than recording a positive partial value", () => {
    expect(extractFields("TOTAL: -1090.00", "receipt")).toEqual({});
    expect(extractFields("TOTAL: 1.09.00", "receipt")).toEqual({});
  });
});

describe("Hybrid PDF identity layout", () => {
  const at = (text: string, x: number, y: number): PositionedText => ({
    text,
    bbox: { x0: x, y0: y, x1: x + 100, y1: y + 10 },
  });
  it("binds a nearby native value to its printed label and preserves Kazakh letters", () => {
    expect(
      extractIdentityLayout(
        [at("СЫНАҚҰЛЫ", 100, 125)],
        [at("ӘКЕСІНІҢ АТЫ / ОТЧЕСТВО", 100, 100)],
      ),
    ).toEqual({ middleName: "СЫНАҚҰЛЫ" });
  });
  it("does not borrow values from another column or distant fields", () => {
    expect(
      extractIdentityLayout(
        [at("ҮЛГІ", 400, 125), at("СЫНАҚ", 100, 200)],
        [at("ТЕГІ / ФАМИЛИЯ", 100, 100)],
      ),
    ).toEqual({});
  });
  it("stops at the next field label when a value is missing", () => {
    expect(
      extractIdentityLayout(
        [at("СЫНАҚ", 100, 145)],
        [at("ТЕГІ", 100, 100), at("АТЫ", 100, 125)],
      ),
    ).toEqual({ firstName: "СЫНАҚ" });
  });
  it("does not choose between ambiguous native text fragments", () => {
    expect(
      extractIdentityLayout(
        [at("ҮЛГІ", 100, 125), at("СЫНАҚ", 115, 125)],
        [at("ТЕГІ", 100, 100)],
      ),
    ).toEqual({});
  });
  it("reads original MRZ spelling but rejects ambiguous or damaged name lines", () => {
    const line = "ULGIKYZY<<AIGUL<<<<<<<<<<<<<<<<<<<<";
    expect(extractFields(line, "identity")).toEqual({
      lastNameLatin: "ULGIKYZY",
      firstNameLatin: "AIGUL",
    });
    expect(extractFields(line + "\n" + line, "identity")).toEqual({});
    expect(
      extractFields("ULG1KYZY<<AIGUL<<<<<<<<<<<<<<<<<<<<", "identity"),
    ).toEqual({});
  });
});

describe("Optional identity document details", () => {
  it("reads separate document numbers, issuing authority and validity dates", () => {
    expect(
      extractFields(
        "ЖСН / ИИН: 000123456789\nКУӘЛІК НӨМІРІ: 001234567\nБЕРГЕН ОРГАН / ОРГАН ВЫДАЧИ\nСЫНАҚ ОРГАНЫ\nБЕРІЛГЕН КҮНІ: 01.02.2020\nСРОК ДЕЙСТВИЯ: 01.02.2030",
        "identity",
      ),
    ).toMatchObject({
      iin: "000123456789",
      documentNumber: "001234567",
      issuedBy: "СЫНАҚ ОРГАНЫ",
      issueDate: "2020-02-01",
      expiryDate: "2030-02-01",
    });
  });
  it("handles unlabeled numbers and a date range only within an identity document", () => {
    const data =
      "000123456789\n001234567\nБЕРІЛГЕН КҮНІ / ДАТА ВЫДАЧИ\n01.02.2020 - 01.02.2030";
    expect(extractFields("ЖЕКЕ КУӘЛІК\n" + data, "identity")).toMatchObject({
      iin: "000123456789",
      documentNumber: "001234567",
      issueDate: "2020-02-01",
      expiryDate: "2030-02-01",
    });
    expect(extractFields("000123456789\n001234567", "identity")).toEqual({});
  });
  it("does not fabricate an authority or take another label for a missing authority", () => {
    const fields = extractFields(
      "КЕМ ВЫДАН\nДАТА ВЫДАЧИ: 01.02.2020",
      "identity",
    );
    expect(fields.issuedBy).toBeUndefined();
    expect(fields.issueDate).toBe("2020-02-01");
  });
});

it("reads adjacent Cyrillic and original Latin name lines under bilingual labels", () => {
  expect(
    extractFields(
      "ТЕГІ / SURNAME\nҮЛГІҚЫЗЫ\nULGIKYZY\nАТЫ / NAME\nАЙГҮЛ\nAIGUL\nТУҒАН КҮНІ\n15.04.1975",
      "identity",
    ),
  ).toMatchObject({
    lastName: "ҮЛГІҚЫЗЫ",
    lastNameLatin: "ULGIKYZY",
    firstName: "АЙГҮЛ",
    firstNameLatin: "AIGUL",
  });
  expect(
    extractFields("ТЕГІ ҮЛГІҚЫЗЫ\nULGIKYZY\nАТЫ АЙГҮЛ\nAIGUL", "identity"),
  ).toMatchObject({ lastNameLatin: "ULGIKYZY", firstNameLatin: "AIGUL" });
  expect(
    extractFields("ТЕГІ ҮЛГІҚЫЗЫ\nАТЫ АЙГҮЛ", "identity").lastNameLatin,
  ).toBeUndefined();
});
it("retains original Latin spelling when OCR inserts spaces in an MRZ line", () => {
  expect(
    extractFields("ULGIKYZY << AIGUL <<<<<<<<<<<<<<<<<<<<", "identity"),
  ).toMatchObject({ lastNameLatin: "ULGIKYZY", firstNameLatin: "AIGUL" });
});

describe("Identity IIN evidence", () => {
  it("reads the printed IIN when a faded title is missing but the birth label and machine row remain", () => {
    expect(
      extractFields(
        "Дата рождения\n15.04.1975\n000123456789\n000001KAZ7504150F3001010123456<0",
        "identity",
      ).iin,
    ).toBe("000123456789");
  });
  it.each([
    "ЖСН / ИИН: 000 123 456 789",
    "IIN\n000123\n456789",
    "ЖЕКЕ КУӘЛІК\n000 123 456 789",
    "SURNAME: TEST\nDATE OF BIRTH: 15.04.1975\n000123456789",
    "SURNAME: TEST\nDATE OF BIRTH: 15.04.1975\nІМ: 000123456789",
  ])("reads spacing and labelled line breaks: %s", (text) => {
    expect(extractFields(text, "identity").iin).toBe("000123456789");
  });
  it.each([
    "IIN: 000123456789\nIIN: 999123456789",
    "ЖЕКЕ КУӘЛІК\n000123456789\n999123456789",
    "IIN: 0001234567890",
    "IIN: 00012345O789",
    "ІМ: 000123456789",
    "SURNAME: TEST\nDATE OF BIRTH: 15.04.1975\nТелефон: 000123456789",
    "000123456789\n001234567",
    "Оплата совершена\n6 487 ₸\n№ чека QR123456789\nИИН/БИН продавца 000123456789",
  ])("does not guess or use conflicting/non-identity digits: %s", (text) => {
    expect(extractFields(text, "identity").iin).toBeUndefined();
  });
});

describe("Empty identity patronymic", () => {
  it.each([
    "УРАН КҮНІ / ДАТА РОЖДЕНИЯ",
    "ТУҒАН КҮНІ / ДАТА РОЖДЕНИЯ",
    "УРАН КҮНІ",
    "МЕСТО РОЖДЕНИЯ",
    "-",
  ])(
    "does not turn the following heading or blank marker into a patronymic: %s",
    (next) => {
      const fields = extractFields(
        `ӘКЕСІНІҢ АТЫ / ОТЧЕСТВО\n${next}\n15.04.1975`,
        "identity",
      );
      expect(fields.middleName).toBe("");
    },
  );
  it("keeps a real patronymic and does not infer one from a name or MRZ", () => {
    expect(
      extractFields(
        "ӘКЕСІНІҢ АТЫ / ОТЧЕСТВО\nСЫНАҚҰЛЫ\nТУҒАН КҮНІ / ДАТА РОЖДЕНИЯ\n15.04.1975",
        "identity",
      ).middleName,
    ).toBe("СЫНАҚҰЛЫ");
    expect(
      extractFields(
        "SURNAME: TEST\nGIVEN NAMES: EXAMPLE\nTEST<<EXAMPLE<<<<<<<<<<<<",
        "identity",
      ).middleName,
    ).toBeUndefined();
  });
  it("treats a bilingual next heading as a boundary in hybrid PDF layout", () => {
    const at = (text: string, y: number): PositionedText => ({
      text,
      bbox: { x0: 100, x1: 400, y0: y, y1: y + 10 },
    });
    expect(
      extractIdentityLayout(
        [at("УРАН КҮНІ / ДАТА РОЖДЕНИЯ", 125)],
        [at("ӘКЕСІНІҢ АТЫ / ОТЧЕСТВО", 100)],
      ),
    ).not.toHaveProperty("middleName");
  });
});
