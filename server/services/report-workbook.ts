import ExcelJS from "exceljs";
import {
  compactRowHeight,
  compactRowLines,
  prepareCompactLayout,
} from "./provincial-sheet-layout.js";
import {
  AGE_LABELS,
  ageAt,
  ageGroup,
  MEMBERSHIP_PAYMENT_LABEL,
  money,
  RECEIPT_TYPES,
  paymentCategoryLabel,
} from "../../shared/domain.js";
import { regionLabel } from "../../shared/locations.js";

export type ReportColumn = {
  header: string;
  key: string;
  width: number;
  money?: boolean;
};
export type ReportHeading = { title: string; purpose: string };
type IncomeTotal = { label: string; amount: number };
const tengeFormat = "#,##0.00";
const ordinalColumn: ReportColumn = { header: "№", key: "rowNumber", width: 6.5 };
export const kkCollator = new Intl.Collator("kk", { numeric: true });

export function startTable(
  book: ExcelJS.Workbook,
  name: string,
  heading: ReportHeading,
  year: number,
  columns: ReportColumn[],
  totals: IncomeTotal[] = [],
  totalsOffset = 0,
  incomeByType: IncomeTotal[] = [],
) {
  const needsOrdinal = !columns.some(
    ({ header }) => header === ordinalColumn.header,
  );
  const tableColumns = needsOrdinal ? [ordinalColumn, ...columns] : columns;
  const sheet = book.addWorksheet(name);
  sheet.columns = tableColumns.map(({ key, width, money }) => ({
    key,
    width,
    style: {
      font: { name: "Calibri", size: 13 },
      alignment: { vertical: "middle", wrapText: true },
      ...(money ? { numFmt: tengeFormat } : {}),
    },
  }));
  sheet.addRow([`${heading.title} · ${year} жыл`]);
  sheet.addRow([heading.purpose]);
  for (const n of [1, 2]) sheet.mergeCells(n, 1, n, tableColumns.length);
  sheet.getRow(1).height = 35;
  sheet.getCell("A1").font = {
    name: "Calibri",
    size: 19,
    bold: true,
    color: { argb: "FF173F35" },
  };
  sheet.getRow(2).height = 36;
  sheet.getCell("A2").alignment = { vertical: "middle", wrapText: true };
  sheet.getCell("A2").font = {
    name: "Calibri",
    size: 13,
    color: { argb: "FF344E45" },
  };
  if (totals.length) {
    const offset = totalsOffset + Number(needsOrdinal);
    const line = sheet.addRow([
      ...Array(offset).fill(null),
      ...totals.flatMap(({ label, amount }) => [label, amount / 100]),
    ]);
    line.height = incomeByType.length ? 57 : 44;
    line.eachCell((cell, column) => {
      cell.font = {
        name: "Calibri",
        size: 14,
        bold: true,
        color: { argb: "FF173F35" },
      };
      cell.alignment = {
        wrapText: true,
        vertical: "middle",
        ...(incomeByType.length ? { indent: 1 } : {}),
      };
      if ((column - offset) % 2 === 0) cell.numFmt = tengeFormat;
    });
  }
  if (incomeByType.length) {
    const title = sheet.addRow([null, "Кіріс түрі бойынша, ₸"]);
    sheet.mergeCells(title.number, 2, title.number, 5);
    title.height = 27;
    title.getCell(2).font = { name: "Calibri", size: 14, bold: true };
    for (let i = 0; i < incomeByType.length; i += 2) {
      const pair = incomeByType.slice(i, i + 2);
      const line = sheet.addRow([
        null,
        ...pair.flatMap(({ label, amount }) => [label, amount / 100]),
      ]);
      line.height = Math.max(
        26,
        ...pair.map(
          ({ label }, index) =>
            22 * Math.ceil(label.length / (index ? 17 : 29)),
        ),
      );
      pair.forEach((_, index) => {
        const labelCell = line.getCell(2 + 2 * index);
        const amountCell = line.getCell(3 + 2 * index);
        amountCell.numFmt = tengeFormat;
        amountCell.font = { name: "Calibri", size: 13, bold: true };
        for (const cell of [labelCell, amountCell]) {
          cell.alignment = { ...cell.alignment, indent: 1 };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: index ? "FFF1F4F2" : "FFE6F1EB" },
          };
        }
      });
    }
  }
  const headers = sheet.addRow(tableColumns.map((c) => c.header));
  const headerRow = headers.number;
  headers.height = 45;
  headers.eachCell((cell) => {
    cell.font = {
      name: "Calibri",
      size: 13,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF205744" },
    };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  // A large catalogue must leave room to scroll through participant rows.
  const freeze = headerRow <= 10;
  sheet.views = freeze
    ? [{ state: "frozen", ySplit: headerRow, showGridLines: true }]
    : [{ state: "normal", showGridLines: true }];
  sheet.pageSetup = {
    orientation: "landscape",
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${freeze ? 1 : headerRow}:${headerRow}`,
  };
  sheet.properties.defaultRowHeight = 21;
  return sheet;
}

export function finishTable(sheet: ExcelJS.Worksheet) {
  const headerRow = Number(sheet.pageSetup.printTitlesRow?.split(":").at(-1));
  const rowCount = sheet.rowCount;
  const firstColumn = sheet.getColumn(1);
  if (firstColumn.key === ordinalColumn.key) {
    firstColumn.width = Math.max(
      ordinalColumn.width,
      String(rowCount - headerRow).length + 2,
    );
    for (let number = headerRow + 1; number <= rowCount; number++) {
      const cell = sheet.getCell(number, 1);
      cell.value = number - headerRow;
      cell.alignment = { horizontal: "center", vertical: "middle" };
    }
  }
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(headerRow, rowCount), column: sheet.columnCount },
  };
}

// Excel stores local calendar values without a timezone. Preserve the printed
// Astana clock by encoding its components directly into the Excel serial.
export function setPaymentDate(
  row: ExcelJS.Row,
  key: string,
  day?: string | null,
  time?: string | null,
) {
  if (!day) return;
  const clock = time?.trim() || "";
  const stamp = new Date(`${day}T${clock || "00:00"}Z`);
  const cell = row.getCell(key);
  if (!Number.isFinite(stamp.getTime())) {
    cell.value = [day, clock].filter(Boolean).join(" ");
    return;
  }
  cell.value = stamp;
  const seconds = Number(clock.split(":")[2]);
  cell.numFmt = clock
    ? seconds
      ? "dd.mm.yyyy hh:mm:ss"
      : "dd.mm.yyyy hh:mm"
    : "dd.mm.yyyy";
}

export type ParticipantInfo = {
  registrationNumber?: number | null;
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  phone?: string | null;
  birthDate?: string | null;
  lastNameLatin?: string | null;
  firstNameLatin?: string | null;
  region?: string | null;
  village?: string | null;
  deletedAt?: Date | null;
  siteHiddenAt?: Date | null;
};
export type ReportPayment = {
  participantId: unknown;
  person?: ParticipantInfo;
  year?: number | null;
  amount?: number | null;
  paymentKind?: string | null;
  paymentCategoryName?: string | null;
  paymentCategoryId?: unknown;
  paymentDate?: string | null;
  paymentTime?: string | null;
  receiptNumber?: string | null;
  payerName?: string | null;
  recipientName?: string | null;
  receiptType?: string | null;
  method?: string | null;
};
export function documentName(p: ParticipantInfo) {
  return [p.lastName, p.firstName, p.middleName].filter(Boolean).join(" ");
}
function personName(p?: ParticipantInfo, allowLatin = true) {
  if (!p || p.deletedAt) return "Жойылған қатысушы";
  if (p.siteHiddenAt) return "Жасырылған қатысушы";
  return (
    documentName(p) ||
    (allowLatin &&
      [p.lastNameLatin, p.firstNameLatin].filter(Boolean).join(" ")) ||
    "Аты-жөні көрсетілмеген"
  );
}
function visibleRegistrationNumber(person?: ParticipantInfo) {
  return person?.siteHiddenAt || person?.deletedAt
    ? null
    : (person?.registrationNumber ?? null);
}
function purposeKey(p: ReportPayment) {
  return p.paymentKind === "additional"
    ? `additional:${p.paymentCategoryId ?? paymentCategoryLabel(p)}`
    : "membership";
}

export type ReportCategory = { id: string; name: string };
const provincialMembershipAmount = 650000; // tiyn, reporting reference only
type RegionalReport = {
  people: (ParticipantInfo & { _id: unknown })[];
  category?: ReportCategory;
  configuredCategories?: string[];
  byRegion: boolean;
  otherIncome?: {
    date?: string | null;
    amount?: number | null;
    category?: string | null;
    description?: string | null;
  }[];
};
const registrationNumberColumn = {
  header: "№",
  key: "registrationNumber",
  width: 10,
};

function provincialIncomeBreakdown(
  categoryAmounts: Map<string, number>,
  purposes: Map<string, string>,
  regional: RegionalReport,
): IncomeTotal[] {
  const grouped = new Map<string, IncomeTotal>();
  function collect(label: string, amount: number) {
    const display = label.trim().replace(/\s+/g, " ");
    const key = display.normalize("NFC").toLocaleLowerCase("kk-KZ");
    const total = grouped.get(key);
    if (total) total.amount += amount;
    else grouped.set(key, { label: display, amount });
  }
  collect(MEMBERSHIP_PAYMENT_LABEL, 0);
  for (const name of regional.configuredCategories || []) collect(name, 0);
  for (const [key, label] of purposes)
    collect(label, categoryAmounts.get(key) || 0);
  for (const entry of regional.otherIncome || [])
    collect(entry.category?.trim() || "Өзге кіріс", entry.amount || 0);
  return [...grouped.values()].sort((a, b) => {
    if (a.label === b.label) return 0;
    if (a.label === MEMBERSHIP_PAYMENT_LABEL) return -1;
    if (b.label === MEMBERSHIP_PAYMENT_LABEL) return 1;
    return kkCollator.compare(a.label, b.label);
  });
}

function provincialPaymentText(
  payment: Pick<ReportPayment, "amount" | "paymentDate" | "paymentTime">,
) {
  const day = payment.paymentDate?.replace(
    /^(\d{4})-(\d{2})-(\d{2})$/,
    "$3.$2.$1",
  );
  const time = payment.paymentTime?.trim().replace(/:(\d{2}):00$/, ":$1");
  const timestamp = [day, time].filter(Boolean).join(" ");
  return [payment.amount == null ? "" : money(payment.amount), timestamp]
    .filter(Boolean)
    .join(" · ");
}

function fillProvincialPayments(
  sheet: ExcelJS.Worksheet,
  firstRow: ExcelJS.Row,
  payments: ReportPayment[],
  countLines: ReturnType<typeof prepareCompactLayout>,
) {
  // The same index connects each payment to its sender and recipient.
  let row = firstRow;
  let lines = new Map<string, string[]>();
  let visualLines = compactRowLines(firstRow, countLines);
  const usedLines = new Map<string, number>();
  function addLine(key: string, value: string, height: number) {
    const used = (usedLines.get(key) ?? 0) + height;
    usedLines.set(key, used);
    visualLines = Math.max(visualLines, used);
    const values = lines.get(key);
    if (values) values.push(value);
    else lines.set(key, [value]);
  }
  function finishRow() {
    for (const [key, values] of lines) {
      const cell = row.getCell(key);
      cell.value = values.join("\n");
      cell.alignment = { vertical: "top", wrapText: true };
    }
    row.height = compactRowHeight(visualLines);
  }
  for (const [index, payment] of payments.entries()) {
    const prefix = payments.length > 1 ? `${index + 1}. ` : "";
    const description = prefix + provincialPaymentText(payment);
    const sender =
      prefix + (payment.payerName?.trim().replace(/\s+/g, " ") || "—");
    const recipient =
      prefix + (payment.recipientName?.trim().replace(/\s+/g, " ") || "—");
    const additions = [
      [purposeKey(payment), description],
      ["sender", sender],
      ["recipient", recipient],
    ].map(([key, value]) => ({ key, value, height: countLines(key, value) }));
    // A single Excel row can be at most 409 points. Continue the payment
    // history before a cell would exceed 23 lines at the retained 13 pt font.
    if (
      lines.size &&
      additions.some(
        ({ key, height }) => (usedLines.get(key) ?? 0) + height > 23,
      )
    ) {
      finishRow();
      row = sheet.addRow({});
      lines = new Map();
      usedLines.clear();
      visualLines = 1;
    }
    for (const { key, value, height } of additions) addLine(key, value, height);
  }
  finishRow();
}

export function addPaymentTables(
  book: ExcelJS.Workbook,
  heading: ReportHeading,
  year: number,
  payments: ReportPayment[],
  regional?: RegionalReport,
) {
  const district = regional?.byRegion === true;
  const provincial = regional !== undefined && !district;
  const accountName = (person?: ParticipantInfo) =>
    personName(person, !district);
  const purposes = new Map<string, string>();
  if (!regional?.byRegion) purposes.set("membership", MEMBERSHIP_PAYMENT_LABEL);
  if (regional?.category)
    purposes.set(`additional:${regional.category.id}`, regional.category.name);
  const people = new Map<
    string,
    {
      person?: ParticipantInfo;
      sums: Map<string, number>;
      latest?: ReportPayment;
      receipts?: ReportPayment[];
    }
  >();
  for (const p of regional?.people || [])
    people.set(String(p._id), { person: p, sums: new Map() });
  const categoryAmounts = new Map<string, number>();
  let received = 0,
    highlighted = 0;
  for (const p of payments) {
    const id = String(p.participantId),
      key = purposeKey(p);
    if (!purposes.has(key)) purposes.set(key, paymentCategoryLabel(p));
    const account = people.get(id) ?? {
      person: p.person,
      latest: p,
      sums: new Map<string, number>(),
    };
    account.latest ??= p;
    if (provincial) {
      (account.receipts ??= []).push(p);
      categoryAmounts.set(
        key,
        (categoryAmounts.get(key) || 0) + (p.amount || 0),
      );
    }
    received += p.amount || 0;
    if (
      provincial &&
      key === "membership" &&
      p.amount === provincialMembershipAmount
    )
      highlighted += p.amount;
    account.sums.set(key, (account.sums.get(key) || 0) + (p.amount || 0));
    people.set(id, account);
  }
  const categories = [...purposes].sort(([a, name], [b, other]) =>
    a === b
      ? 0
      : a === "membership"
        ? -1
        : b === "membership"
          ? 1
          : name.localeCompare(other, "kk") || a.localeCompare(b),
  );
  const otherTotal =
    regional?.otherIncome?.reduce(
      (sum, entry) => sum + (entry.amount || 0),
      0,
    ) || 0;
  const totals = regional
    ? [
        {
          label: regional.otherIncome ? "Жалпы кіріс, ₸" : "Төлемдер жиыны, ₸",
          amount: received + otherTotal,
        },
        ...(regional.otherIncome
          ? [
              { label: "Оның ішінде қатысушылардан, ₸", amount: received },
              { label: "Өзге кірістер, ₸", amount: otherTotal },
            ]
          : []),
        ...(regional.byRegion
          ? []
          : [
              {
                label: "Оның ішінде 6 500 ₸ мүшелік жарна, ₸",
                amount: highlighted,
              },
            ]),
      ]
    : [{ label: "Төлемдер жиыны, ₸", amount: received }];
  const areaColumns = [
    { header: "Аймақ", key: "region", width: district ? 26 : 34 },
    { header: "Елді мекен", key: "village", width: district ? 17 : 23 },
  ];
  const categoryColumns = categories.map(([key, label]) => ({
    header:
      provincial && key === "membership"
        ? "Мүшелік жарна (6 500 ₸)"
        : `${label}, ₸`,
    key,
    width: provincial ? 32 : district ? 17 : 24,
    money: !provincial,
  }));
  const summary = startTable(
    book,
    "Қатысушылар",
    heading,
    year,
    [
      ...(provincial ? [{ ...registrationNumberColumn, width: 6.5 }] : []),
      {
        header: regional ? "Аты-жөні (құжат бойынша)" : "Қатысушы",
        key: "name",
        width: regional ? 30 : 36,
      },
      ...(provincial
        ? [
            { header: "Туған күні", key: "birthDate", width: 14 },
            { header: "Телефон", key: "phone", width: 20 },
            { header: "Жасы", key: "age", width: 8 },
            { header: "Жас санаты", key: "ageGroup", width: 18 },
            { ...areaColumns[0], width: 26 },
          ]
        : regional
          ? [
              { header: "Телефон", key: "phone", width: 20 },
              { header: "Туған күні", key: "birthDate", width: 14 },
              { header: "Жас санаты", key: "ageGroup", width: 18 },
            ]
          : []),
      ...(!provincial
        ? [
            ...areaColumns,
            {
              header: "Соңғы чек күні мен уақыты (Астана)",
              key: "latest",
              width: district ? 23 : 25,
            },
          ]
        : []),
      ...categoryColumns,
      {
        header: "Барлығы, ₸",
        key: "total",
        width: regional ? 15 : 22,
        money: true,
      },
      ...(provincial
        ? [
            { header: "Жіберуші", key: "sender", width: 21 },
            { header: "Алушы", key: "recipient", width: 45 },
            { ...areaColumns[1], width: 17 },
          ]
        : []),
    ],
    totals,
    provincial ? 1 : 0,
    provincial
      ? provincialIncomeBreakdown(categoryAmounts, purposes, regional)
      : [],
  );
  const accounts = [...people.values()].sort((a, b) => {
    if (provincial) {
      const first = visibleRegistrationNumber(a.person) ?? Infinity;
      const second = visibleRegistrationNumber(b.person) ?? Infinity;
      if (first !== second) return first - second;
    }
    if (regional?.byRegion) {
      const location = kkCollator.compare(
        regionLabel(a.person?.region || ""),
        regionLabel(b.person?.region || ""),
      );
      const byAreaThenTime =
        location ||
        (b.latest?.paymentDate || "").localeCompare(
          a.latest?.paymentDate || "",
        ) ||
        (b.latest?.paymentTime || "").localeCompare(
          a.latest?.paymentTime || "",
        );
      if (byAreaThenTime) return byAreaThenTime;
    }
    return kkCollator.compare(accountName(a.person), accountName(b.person));
  });
  const countLines = regional
    ? prepareCompactLayout(summary, {
        incomeBreakdown: provincial,
        largestNumber: provincial
          ? accounts.reduce(
              (max, a) =>
                Math.max(max, visibleRegistrationNumber(a.person) ?? 0),
              0,
            )
          : undefined,
        moneyWidths: {
          total: received / 100,
          ...(district
            ? Object.fromEntries(
                categoryColumns.map(({ key }) => [key, received / 100]),
              )
            : {}),
        },
      })
    : undefined;
  for (const account of accounts) {
    const p = account.person;
    const age = regional ? ageAt(p?.birthDate || "") : NaN;
    const group = ageGroup(age);
    const row = summary.addRow({
      ...(provincial
        ? { registrationNumber: visibleRegistrationNumber(p) }
        : {}),
      name: accountName(p),
      ...(regional
        ? {
            ...(provincial ? { age: Number.isFinite(age) ? age : null } : {}),
            phone: p?.phone,
            ageGroup: group === null ? null : AGE_LABELS[group],
          }
        : {}),
      region: regionLabel(p?.region || ""),
      village: p?.village,
      ...(!provincial
        ? Object.fromEntries(
            categories.map(([key]) => [
              key,
              (account.sums.get(key) || 0) / 100,
            ]),
          )
        : {}),
      total: [...account.sums.values()].reduce((a, b) => a + b, 0) / 100,
    });
    if (regional) setPaymentDate(row, "birthDate", p?.birthDate);
    if (provincial && countLines) {
      for (const key of ["age", "registrationNumber"])
        row.getCell(key).alignment = {
          vertical: "middle",
          horizontal: "center",
        };
      fillProvincialPayments(summary, row, account.receipts || [], countLines);
    } else
      setPaymentDate(
        row,
        "latest",
        account.latest?.paymentDate,
        account.latest?.paymentTime,
      );
    if (district && countLines)
      row.height = compactRowHeight(compactRowLines(row, countLines));
  }
  finishTable(summary);
  const details = startTable(
    book,
    "Төлемдер",
    {
      title: heading.title,
      purpose:
        (regional ? heading.purpose + " " : "") +
        "Әр жолда бір төлем көрсетілген. Соңғы төлемдер жоғарыда.",
    },
    year,
    [
      ...(provincial ? [registrationNumberColumn] : []),
      { header: "Қатысушы", key: "name", width: district ? 30 : 36 },
      ...(provincial
        ? [
            {
              header: "Сома, күні мен уақыты (Астана)",
              key: "payment",
              width: 40,
            },
          ]
        : [
            {
              header: "Чек күні мен уақыты (Астана)",
              key: "paidAt",
              width: district ? 23 : 26,
            },
          ]),
      { header: "Төлем мақсаты", key: "purpose", width: district ? 21 : 28 },
      ...(!provincial
        ? [
            {
              header: "Сома, ₸",
              key: "amount",
              width: district ? 15 : 18,
              money: true,
            },
          ]
        : []),
      {
        header: provincial ? "Жіберуші" : "Төлеген адам",
        key: "payerName",
        width: district ? 23 : 28,
      },
      { header: "Алушы", key: "recipientName", width: district ? 34 : 37 },
      { header: "Чек нөмірі", key: "receiptNumber", width: district ? 23 : 29 },
      { header: "Төлем тәсілі", key: "method", width: district ? 17 : 24 },
      {
        header: "Чек түрі",
        key: "receiptTypeLabel",
        width: district ? 22 : 26,
      },
      { header: "Жарна жылы", key: "year", width: district ? 12 : 15 },
    ],
  );
  const detailLines = district
    ? prepareCompactLayout(details, {
        moneyWidths: {
          amount:
            payments.reduce(
              (highest, payment) => Math.max(highest, payment.amount ?? 0),
              0,
            ) / 100,
        },
      })
    : undefined;
  for (const p of payments) {
    const row = details.addRow({
      ...p,
      name: accountName(p.person),
      purpose: paymentCategoryLabel(p),
      receiptTypeLabel:
        RECEIPT_TYPES[p.receiptType as keyof typeof RECEIPT_TYPES] || "",
      ...(provincial
        ? {
            registrationNumber: visibleRegistrationNumber(p.person),
            payment: provincialPaymentText(p),
          }
        : { amount: (p.amount || 0) / 100 }),
    });
    if (!provincial)
      setPaymentDate(row, "paidAt", p.paymentDate, p.paymentTime);
    if (detailLines)
      row.height = compactRowHeight(compactRowLines(row, detailLines));
  }
  finishTable(details);
  if (regional?.otherIncome) {
    const sheet = startTable(
      book,
      "Өзге кірістер",
      {
        title: heading.title,
        purpose:
          "Қатысушыға тіркелмеген өзге кірістер облыстың жалпы кірісіне енгізілген.",
      },
      year,
      [
        { header: "Сомасы мен күні", key: "datedAmount", width: 36 },
        { header: "Санат", key: "category", width: 36 },
        { header: "Түсініктеме", key: "description", width: 55 },
      ],
    );
    for (const entry of regional.otherIncome) {
      sheet.addRow({
        datedAmount: provincialPaymentText({
          amount: entry.amount,
          paymentDate: entry.date,
        }),
        category: entry.category,
        description: entry.description,
      });
    }
    finishTable(sheet);
  }
}
