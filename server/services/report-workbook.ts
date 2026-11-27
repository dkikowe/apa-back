import ExcelJS from "exceljs";
import {
  AGE_LABELS,
  ageAt,
  ageGroup,
  MEMBERSHIP_PAYMENT_LABEL,
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
  const sheet = book.addWorksheet(name);
  sheet.columns = columns.map(({ key, width, money }) => ({
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
  for (const n of [1, 2]) sheet.mergeCells(n, 1, n, columns.length);
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
    const line = sheet.addRow([
      ...Array(totalsOffset).fill(null),
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
      if ((column - totalsOffset) % 2 === 0) cell.numFmt = tengeFormat;
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
  const headers = sheet.addRow(columns.map((c) => c.header));
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
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(headerRow, sheet.rowCount), column: sheet.columnCount },
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
  fullNameKk?: string | null;
  fullNameRu?: string | null;
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
function personName(p?: ParticipantInfo) {
  if (!p || p.deletedAt) return "Жойылған қатысушы";
  if (p.siteHiddenAt) return "Жасырылған қатысушы";
  return (
    documentName(p) ||
    [p.lastNameLatin, p.firstNameLatin].filter(Boolean).join(" ") ||
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

function fillProvincialPaymentDates(
  sheet: ExcelJS.Worksheet,
  firstRow: ExcelJS.Row,
  payments: ReportPayment[],
) {
  // For multiple payments the same index identifies the date, sender and recipient,
  // even when different purposes put the dates in different columns.
  let row = firstRow;
  let lines = new Map<string, string[]>();
  let visualLines = 0;
  function addLine(key: string, value: string) {
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
    row.height = Math.max(42, Math.min(409, visualLines * 22 + 4));
  }
  for (const [index, payment] of payments.entries()) {
    const prefix = payments.length > 1 ? `${index + 1}. ` : "";
    const sender =
      prefix + (payment.payerName?.trim().replace(/\s+/g, " ") || "—");
    const recipient =
      prefix + (payment.recipientName?.trim().replace(/\s+/g, " ") || "—");
    const height = Math.max(
      1,
      Math.ceil(sender.length / 24),
      Math.ceil(recipient.length / 40),
    );
    if (visualLines && visualLines + height > 17) {
      finishRow();
      row = sheet.addRow({});
      lines = new Map();
      visualLines = 0;
    }
    const dateKey = `date:${purposeKey(payment)}`;
    if (payments.length === 1) {
      setPaymentDate(row, dateKey, payment.paymentDate, payment.paymentTime);
    } else {
      const day = payment.paymentDate?.replace(
        /^(\d{4})-(\d{2})-(\d{2})$/,
        "$3.$2.$1",
      );
      const time = payment.paymentTime?.replace(/:(\d{2}):00$/, ":$1");
      addLine(dateKey, prefix + [day, time].filter(Boolean).join(" "));
    }
    addLine("sender", sender);
    addLine("recipient", recipient);
    visualLines += height;
  }
  if (visualLines) finishRow();
}

export function addPaymentTables(
  book: ExcelJS.Workbook,
  heading: ReportHeading,
  year: number,
  payments: ReportPayment[],
  regional?: RegionalReport,
) {
  const provincial = regional !== undefined && !regional.byRegion;
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
    { header: "Аймақ", key: "region", width: 34 },
    { header: "Елді мекен", key: "village", width: 23 },
  ];
  const categoryColumns = categories.flatMap(([key, label]) => [
    {
      header:
        provincial && key === "membership"
          ? "Мүшелік жарна (6 500 ₸)"
          : `${label}, ₸`,
      key,
      width: 24,
      money: true,
    },
    ...(provincial
      ? [
          {
            header: `Күні мен уақыты — ${label}`,
            key: `date:${key}`,
            width: 29,
          },
        ]
      : []),
  ]);
  const summary = startTable(
    book,
    "Қатысушылар",
    heading,
    year,
    [
      ...(provincial ? [registrationNumberColumn] : []),
      {
        header: regional ? "Аты-жөні (құжат бойынша)" : "Қатысушы",
        key: "name",
        width: 36,
      },
      ...(provincial
        ? [
            { header: "Туған күні", key: "birthDate", width: 17 },
            { header: "Телефон", key: "phone", width: 20 },
            { header: "Жасы", key: "age", width: 16 },
            { header: "Жас санаты", key: "ageGroup", width: 23 },
            areaColumns[0],
          ]
        : regional
          ? [
              { header: "Қазақша аты-жөні", key: "fullNameKk", width: 32 },
              { header: "Орысша аты-жөні", key: "fullNameRu", width: 32 },
              { header: "Телефон", key: "phone", width: 20 },
              { header: "Туған күні", key: "birthDate", width: 17 },
              { header: "Жас санаты", key: "ageGroup", width: 23 },
            ]
          : []),
      ...(!provincial
        ? [
            ...areaColumns,
            {
              header: "Соңғы чек күні мен уақыты (Астана)",
              key: "latest",
              width: 25,
            },
          ]
        : []),
      ...categoryColumns,
      { header: "Барлығы, ₸", key: "total", width: 22, money: true },
      ...(provincial
        ? [
            { header: "Жіберуші", key: "sender", width: 30 },
            { header: "Алушы", key: "recipient", width: 52 },
            areaColumns[1],
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
    return kkCollator.compare(personName(a.person), personName(b.person));
  });
  for (const account of accounts) {
    const p = account.person;
    const amounts = categories.map(([key]) => account.sums.get(key) || 0);
    const age = regional ? ageAt(p?.birthDate || "") : NaN;
    const group = ageGroup(age);
    const row = summary.addRow({
      ...(provincial
        ? { registrationNumber: visibleRegistrationNumber(p) }
        : {}),
      name: personName(p),
      ...(regional
        ? {
            ...(provincial
              ? { age: Number.isFinite(age) ? age : null }
              : { fullNameKk: p?.fullNameKk, fullNameRu: p?.fullNameRu }),
            phone: p?.phone,
            ageGroup: group === null ? null : AGE_LABELS[group],
          }
        : {}),
      region: regionLabel(p?.region || ""),
      village: p?.village,
      ...Object.fromEntries(
        categories.map(([key], index) => [key, amounts[index] / 100]),
      ),
      total: amounts.reduce((a, b) => a + b, 0) / 100,
    });
    if (provincial)
      fillProvincialPaymentDates(summary, row, account.receipts || []);
    else
      setPaymentDate(
        row,
        "latest",
        account.latest?.paymentDate,
        account.latest?.paymentTime,
      );
    if (regional) setPaymentDate(row, "birthDate", p?.birthDate);
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
      { header: "Қатысушы", key: "name", width: 36 },
      {
        header: provincial
          ? "Төлем күні мен уақыты (Астана)"
          : "Чек күні мен уақыты (Астана)",
        key: "paidAt",
        width: 26,
      },
      { header: "Төлем мақсаты", key: "purpose", width: 28 },
      { header: "Сома, ₸", key: "amount", width: 18, money: true },
      {
        header: provincial ? "Жіберуші" : "Төлеген адам",
        key: "payerName",
        width: 28,
      },
      { header: "Алушы", key: "recipientName", width: 37 },
      { header: "Чек нөмірі", key: "receiptNumber", width: 29 },
      { header: "Төлем тәсілі", key: "method", width: 24 },
      { header: "Чек түрі", key: "receiptTypeLabel", width: 26 },
      { header: "Жарна жылы", key: "year", width: 15 },
    ],
  );
  for (const p of payments) {
    const row = details.addRow({
      ...p,
      name: personName(p.person),
      purpose: paymentCategoryLabel(p),
      receiptTypeLabel:
        RECEIPT_TYPES[p.receiptType as keyof typeof RECEIPT_TYPES] || "",
      amount: (p.amount || 0) / 100,
      ...(provincial
        ? {
            registrationNumber: visibleRegistrationNumber(p.person),
          }
        : {}),
    });
    setPaymentDate(row, "paidAt", p.paymentDate, p.paymentTime);
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
        { header: "Күні", key: "date", width: 20 },
        { header: "Санат", key: "category", width: 36 },
        { header: "Сома, ₸", key: "amount", width: 25, money: true },
        { header: "Түсініктеме", key: "description", width: 55 },
      ],
    );
    for (const entry of regional.otherIncome) {
      const row = sheet.addRow({
        ...entry,
        date: null,
        amount: (entry.amount || 0) / 100,
      });
      setPaymentDate(row, "date", entry.date);
    }
    finishTable(sheet);
  }
}
