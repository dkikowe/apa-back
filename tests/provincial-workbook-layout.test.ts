import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { money } from "../shared/domain.js";
import { addPaymentTables } from "../server/services/report-workbook.js";

it("keeps short provincial rows compact while preserving wrapped text, long payment histories and numeric totals", async () => {
  const people = [
    { _id: "short", registrationNumber: 1, firstName: "Үлгі" },
    {
      _id: "long-name",
      registrationNumber: 2,
      lastName: "Ұзын-Тегінің-Сынағы",
      firstName: "Бірнеше-Сөзден-Құралған",
      middleName: "Қатысушының-Әкесінің-Аты",
    },
    { _id: "long-recipient", registrationNumber: 3, firstName: "Төлем" },
    { _id: "history", registrationNumber: 4, firstName: "Тарих" },
  ];
  const day = { paymentDate: "2026-10-01", paymentTime: "10:15" };
  const history = Array.from({ length: 60 }, (_, i) => ({
    ...day,
    participantId: "history",
    amount: 123456789 + i,
    paymentKind: "additional",
    paymentCategoryName: "Көрме",
  }));
  const recipient =
    "Қолөнершілер бірлестігінің облыстық бөлімшесі және аудандық көрме ұйымдастырушылары";
  const historyTotal = history.reduce(
    (sum, payment) => sum + payment.amount,
    0,
  );
  const received = 650000 + 123400 + historyTotal;
  const other = 8765432199;
  const book = new ExcelJS.Workbook();
  addPaymentTables(
    book,
    { title: "Облыстық есеп", purpose: "Сынақ" },
    2026,
    [
      { ...day, participantId: "short", amount: 650000 },
      {
        ...day,
        participantId: "long-recipient",
        amount: 123400,
        recipientName: recipient,
      },
      ...history,
    ],
    {
      people,
      byRegion: false,
      otherIncome: [{ amount: other, category: "Кіріс" }],
    },
  );

  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(await book.xlsx.writeBuffer());
  const sheet = exported.getWorksheet("Қатысушылар")!;
  expect(
    ["C3", "E3", "G3", "I3"].map((address) => sheet.getCell(address).value),
  ).toEqual([(received + other) / 100, received / 100, other / 100, 6500]);
  const header = Number(/^A(\d+):/.exec(String(sheet.autoFilter))![1]);
  const headers = sheet.getRow(header).values as ExcelJS.CellValue[];
  const col = (title: string) => headers.indexOf(title);
  expect(sheet.getColumn(col("№")).width).toBeLessThan(10);
  const [short, longName, longRecipient, ...historyRows] = sheet.getRows(
    header + 1,
    sheet.rowCount - header,
  )!;
  expect(short.getCell(col("Аты-жөні (құжат бойынша)")).font).toMatchObject({
    name: "Calibri",
    size: 13,
  });
  const height = (row: ExcelJS.Row) =>
    row.height ?? sheet.properties.defaultRowHeight;
  expect(height(short)).toBeGreaterThanOrEqual(19);
  expect(height(short)).toBeLessThanOrEqual(24);
  expect(short.getCell(col("Мүшелік жарна (6 500 ₸)")).text).toBe(
    "6\u202f500 ₸ · 01.10.2026 10:15",
  );
  expect(height(longName)).toBeGreaterThan(height(short));
  expect(height(longRecipient)).toBeGreaterThan(height(short));
  expect(longRecipient.getCell(col("Алушы")).text).toBe(recipient);
  expect(longRecipient.getCell(col("Алушы")).alignment.wrapText).toBe(true);

  expect(historyRows.length).toBeGreaterThan(1);
  expect(historyRows.every((row) => row.height > 0 && row.height <= 409)).toBe(
    true,
  );
  expect(
    historyRows.flatMap((row) => row.getCell(col("Көрме, ₸")).text.split("\n")),
  ).toEqual(
    history.map(
      ({ amount }, i) => `${i + 1}. ${money(amount)} · 01.10.2026 10:15`,
    ),
  );
  expect(
    historyRows
      .map((row) => row.getCell(col("Барлығы, ₸")).value)
      .filter((value) => value != null),
  ).toEqual([historyTotal / 100]);
});
