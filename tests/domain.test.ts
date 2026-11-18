import { describe, it, expect } from "vitest";
import {
  ageAt,
  ageGroup,
  balance,
  FEE,
  parseMoney,
  participantSchema,
} from "../shared/domain.js";
import { extractFields } from "../server/services/ocr.js";
describe("Age and money", () => {
  it("calculates age on the birthday, not by a stored value", () => {
    expect(ageAt("2000-11-19", "2026-11-18")).toBe(25);
    expect(ageAt("2000-11-18", "2026-11-18")).toBe(26);
    expect(ageAt("2000-02-29", "2025-02-28")).toBe(24);
    expect(ageAt("2000-02-29", "2025-03-01")).toBe(25);
  });
  it.each([
    [24, 0],
    [25, 1],
    [44, 1],
    [45, 2],
    [64, 2],
    [65, 3],
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
