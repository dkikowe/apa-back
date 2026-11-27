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
const tengeFormat = "#,##0.00";
export const kkCollator = new Intl.Collator("kk", { numeric: true });

export function startTable(
  book: ExcelJS.Workbook,
  name: string,
  heading: ReportHeading,
  year: number,
  columns: ReportColumn[],
  totals: { label: string; amount: number }[] = [],
) {
  const headerRow = totals.length ? 4 : 3;
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
    const line = sheet.addRow(
      totals.flatMap(({ label, amount }) => [label, amount / 100]),
    );
    line.height = 44;
    line.eachCell((cell, column) => {
      cell.font = {
        name: "Calibri",
        size: 14,
        bold: true,
        color: { argb: "FF173F35" },
      };
      cell.alignment = { wrapText: true, vertical: "middle" };
      if (column % 2 === 0) cell.numFmt = tengeFormat;
    });
  }
  const headers = sheet.addRow(columns.map((c) => c.header));
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
  sheet.views = [{ state: "frozen", ySplit: headerRow, showGridLines: true }];
  sheet.pageSetup = {
    orientation: "landscape",
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `1:${headerRow}`,
  };
  sheet.properties.defaultRowHeight = 21;
  return sheet;
}

export function finishTable(sheet: ExcelJS.Worksheet) {
  const view = sheet.views[0];
  const headerRow = view?.state === "frozen" ? view.ySplit || 3 : 3;
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
  byRegion: boolean;
  otherIncome?: {
    date?: string | null;
    amount?: number | null;
    category?: string | null;
    description?: string | null;
  }[];
};
export function addPaymentTables(
  book: ExcelJS.Workbook,
  heading: ReportHeading,
  year: number,
  payments: ReportPayment[],
  regional?: RegionalReport,
) {
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
    }
  >();
  for (const p of regional?.people || [])
    people.set(String(p._id), { person: p, sums: new Map() });
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
    received += p.amount || 0;
    if (
      regional &&
      !regional.byRegion &&
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
  const summary = startTable(
    book,
    "Қатысушылар",
    heading,
    year,
    [
      {
        header: regional ? "Аты-жөні (құжат бойынша)" : "Қатысушы",
        key: "name",
        width: 36,
      },
      ...(regional
        ? [
            { header: "Қазақша аты-жөні", key: "fullNameKk", width: 32 },
            { header: "Орысша аты-жөні", key: "fullNameRu", width: 32 },
            { header: "Телефон", key: "phone", width: 20 },
            { header: "Туған күні", key: "birthDate", width: 17 },
            { header: "Жас санаты", key: "ageGroup", width: 23 },
          ]
        : []),
      { header: "Аймақ", key: "region", width: 34 },
      { header: "Елді мекен", key: "village", width: 23 },
      {
        header: "Соңғы чек күні мен уақыты (Астана)",
        key: "latest",
        width: 25,
      },
      ...categories.map(([key, header]) => ({
        header: `${header}, ₸`,
        key,
        width: 24,
        money: true,
      })),
      { header: "Барлығы, ₸", key: "total", width: 22, money: true },
    ],
    totals,
  );
  const accounts = [...people.values()].sort((a, b) => {
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
    const group = regional ? ageGroup(ageAt(p?.birthDate || "")) : null;
    const row = summary.addRow({
      name: personName(p),
      ...(regional
        ? {
            fullNameKk: p?.fullNameKk,
            fullNameRu: p?.fullNameRu,
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
      { header: "Қатысушы", key: "name", width: 36 },
      { header: "Чек күні мен уақыты (Астана)", key: "paidAt", width: 24 },
      { header: "Төлем мақсаты", key: "purpose", width: 28 },
      { header: "Сома, ₸", key: "amount", width: 18, money: true },
      { header: "Төлеген адам", key: "payerName", width: 28 },
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
