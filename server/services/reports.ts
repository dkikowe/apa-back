import ExcelJS from "exceljs";
import { Types } from "mongoose";
import { REPORT_TITLES, type ReportType } from "../../shared/report-names.js";
import { regionLabel } from "../../shared/locations.js";
import { Participant, Payment, Finance } from "../models.js";
import { filtersSchema, memberPipeline, type Filters } from "./members.js";
import { backfillRegistrationNumbers } from "./registration-numbers.js";
import {
  AGE_LABELS,
  dateSchema,
  paymentCategoryLabel,
  STATUS_LABELS,
  missingParticipantFields,
  validIdentityIssuer,
  validityPeriod,
} from "../../shared/domain.js";
import {
  addPaymentTables,
  finishTable,
  setPaymentDate,
  startTable,
  type ReportColumn,
  documentName,
  kkCollator,
  type ReportPayment,
  type ReportHeading,
  type ReportCategory,
} from "./report-workbook.js";

const purposes: Record<ReportType, string> = {
  "mangystau-oblast":
    "Мүшелік жарна және өзге төлемдер нақты төленген сома бойынша көрсетілген. Чектер Астана уақытымен берілген.",
  "mangystau-district":
    "Аймақ пен елді мекен бойынша қатысушылардың қосымша төлемдері.",
  awards:
    "Марапат қағазына жазылатын аты-жөні. Тізім аймақ пен аты-жөні бойынша реттелген.",
  urshyk:
    "Республикалық «Ұршық» бірлестігіне жіберілетін қатысушылар мен төленген мүшелік жарналар.",
  international:
    "Қатысушылардың аты-жөні, туған күні және жеке куәлік деректері.",
  members:
    "Таңдалған қатысушылардың жеке мәліметтері мен жылдық жарнасының жағдайы.",
  payments: "Әр қатысушының жарналары төлем мақсаты бойынша жинақталған.",
  income:
    "Жыл ішінде түскен мүшелік жарналар, қосымша төлемдер және өзге кірістер.",
  expense: "Жыл ішінде тіркелген шығыстар, олардың санаты мен түсініктемесі.",
  financial: "Күнтізбелік жылдағы кіріс, шығыс және есептік қалдық.",
};

export async function financialSummary(year: number) {
  const from = `${year}-01-01`,
    to = `${year + 1}-01-01`;
  const [members, other, months, memberMonths] = await Promise.all([
    Payment.aggregate([
      { $match: { voidedAt: null, paymentDate: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $ifNull: ["$paymentKind", "membership"] },
          total: { $sum: "$amount" },
        },
      },
    ]),
    Finance.aggregate([
      { $match: { voidedAt: null, date: { $gte: from, $lt: to } } },
      { $group: { _id: "$type", total: { $sum: "$amount" } } },
    ]),
    Finance.aggregate([
      { $match: { voidedAt: null, date: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { month: { $substrBytes: ["$date", 5, 2] }, type: "$type" },
          total: { $sum: "$amount" },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { voidedAt: null, paymentDate: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: {
            month: { $substrBytes: ["$paymentDate", 5, 2] },
            kind: { $ifNull: ["$paymentKind", "membership"] },
          },
          total: { $sum: "$amount" },
        },
      },
    ]),
  ]);
  const membership = members.find((x) => x._id === "membership")?.total || 0,
    additional = members.find((x) => x._id === "additional")?.total || 0,
    income = other.find((x) => x._id === "income")?.total || 0,
    expense = other.find((x) => x._id === "expense")?.total || 0;
  return {
    membership,
    additional,
    income,
    expense,
    totalIncome: membership + additional + income,
    balance: membership + additional + income - expense,
    months: Array.from({ length: 12 }, (_, i) => {
      const key = String(i + 1).padStart(2, "0");
      return {
        month: i + 1,
        membership:
          memberMonths.find(
            (x) => x._id.month === key && x._id.kind === "membership",
          )?.total || 0,
        additional:
          memberMonths.find(
            (x) => x._id.month === key && x._id.kind === "additional",
          )?.total || 0,
        income:
          months.find((x) => x._id.month === key && x._id.type === "income")
            ?.total || 0,
        expense:
          months.find((x) => x._id.month === key && x._id.type === "expense")
            ?.total || 0,
      };
    }),
  };
}
export async function statistics(f: Filters) {
  const [rows, finance] = await Promise.all([
    Participant.aggregate([
      ...memberPipeline(f),
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
                partial: {
                  $sum: { $cond: [{ $eq: ["$status", "partial"] }, 1, 0] },
                },
                unpaid: {
                  $sum: { $cond: [{ $eq: ["$status", "unpaid"] }, 1, 0] },
                },
                totalPaid: { $sum: "$totalPaid" },
                remaining: { $sum: "$remaining" },
                overpayment: { $sum: "$overpayment" },
              },
            },
          ],
          regions: [{ $group: { _id: "$region", count: { $sum: 1 } } }],
          ages: [{ $group: { _id: "$ageGroup", count: { $sum: 1 } } }],
        },
      },
    ]),
    financialSummary(f.year),
  ]);
  return {
    ...rows[0],
    totals: rows[0].totals[0] || {
      count: 0,
      paid: 0,
      partial: 0,
      unpaid: 0,
      totalPaid: 0,
      remaining: 0,
      overpayment: 0,
    },
    finance,
  };
}
export const reportTypes = Object.keys(REPORT_TITLES) as [
  ReportType,
  ...ReportType[],
];
const reportPersonProjection = {
  registrationNumber: 1,
  lastName: 1,
  firstName: 1,
  middleName: 1,
  fullNameKk: 1,
  fullNameRu: 1,
  phone: 1,
  birthDate: 1,
  lastNameLatin: 1,
  firstNameLatin: 1,
  region: 1,
  village: 1,
  deletedAt: 1,
  siteHiddenAt: 1,
};
async function reportPayments(
  match: Record<string, unknown>,
  region = "",
): Promise<ReportPayment[]> {
  return Payment.aggregate<ReportPayment>([
    { $match: { ...match, voidedAt: null } },
    { $sort: { paymentDate: -1, paymentTime: -1, createdAt: -1, _id: -1 } },
    {
      $lookup: {
        from: Participant.collection.name,
        localField: "participantId",
        foreignField: "_id",
        pipeline: [
          {
            $project: reportPersonProjection,
          },
        ],
        as: "person",
      },
    },
    { $set: { person: { $arrayElemAt: ["$person", 0] } } },
    ...(region
      ? [{ $match: { "person.region": region, "person.deletedAt": null } }]
      : []),
    {
      $project: {
        participantId: 1,
        // Keep the ledger entry and its region filter while omitting hidden profile details.
        person: {
          $cond: [
            { $ifNull: ["$person.siteHiddenAt", false] },
            { siteHiddenAt: "$person.siteHiddenAt" },
            "$person",
          ],
        },
        year: 1,
        amount: 1,
        paymentKind: 1,
        paymentCategoryName: 1,
        paymentCategoryId: 1,
        paymentDate: 1,
        paymentTime: 1,
        receiptNumber: 1,
        payerName: 1,
        recipientName: 1,
        receiptType: 1,
        method: 1,
      },
    },
  ]);
}
type RosterType = "awards" | "urshyk" | "international";

const nativeName = {
  header: "Аты-жөні (құжат бойынша)",
  key: "name",
  width: 39,
};
const rosterColumns: Record<RosterType, ReportColumn[]> = {
  awards: [
    nativeName,
    { header: "Аймақ", key: "region", width: 40 },
    { header: "Елді мекен", key: "village", width: 27 },
  ],
  urshyk: [
    nativeName,
    { header: "Қазақша аты-жөні", key: "fullNameKk", width: 32 },
    { header: "Орысша аты-жөні", key: "fullNameRu", width: 32 },
    { header: "Латынша тегі", key: "lastNameLatin", width: 24 },
    { header: "Латынша аты", key: "firstNameLatin", width: 24 },
    { header: "ЖСН", key: "iin", width: 19 },
    { header: "Куәлік нөмірі", key: "documentNumber", width: 20 },
    { header: "Кім берді", key: "issuedBy", width: 43 },
    { header: "Жарамдылық мерзімі", key: "validity", width: 31 },
    { header: "Туған жылы", key: "birthYear", width: 16 },
    { header: "Жасы", key: "age", width: 10 },
    { header: "Жас санаты", key: "ageLabel", width: 28 },
    {
      header: "Төленген мүшелік жарна, ₸",
      key: "totalPaid",
      width: 25,
      money: true,
    },
  ],
  international: [
    { ...nativeName, width: 48 },
    { header: "Туған күні", key: "birthDate", width: 18 },
    { header: "Жынысы", key: "sex", width: 26 },
    { header: "Азаматтығы", key: "citizenship", width: 25 },
    { header: "Туған жері", key: "birthplace", width: 35 },
    { header: "Куәлік нөмірі", key: "documentNumber", width: 20 },
    { header: "Кім берді", key: "issuedBy", width: 43 },
    { header: "Жарамдылық мерзімі", key: "validity", width: 31 },
  ],
};

async function addRoster(
  book: ExcelJS.Workbook,
  type: RosterType,
  heading: ReportHeading,
  f: Filters,
) {
  const sheet = startTable(
    book,
    "Қатысушылар",
    heading,
    f.year,
    rosterColumns[type],
  );
  const people = await Participant.aggregate(
    memberPipeline(filtersSchema.parse({ year: f.year, region: f.region })),
  );
  people.sort(
    (a, b) =>
      (type === "awards"
        ? kkCollator.compare(regionLabel(a.region), regionLabel(b.region))
        : 0) ||
      kkCollator.compare(documentName(a), documentName(b)) ||
      String(a._id).localeCompare(String(b._id)),
  );
  for (const p of people) {
    if (type === "international") {
      const latin = [p.lastNameLatin, p.firstNameLatin]
        .filter(Boolean)
        .join(" ");
      const native = documentName(p) || p.fullNameKk || p.fullNameRu || "";
      const names = [latin, native]
        .map((name: string) => name.trim().replace(/\s+/g, " "))
        .filter(
          (name, i, all) =>
            name &&
            (i === 0 ||
              name.localeCompare(all[0], "kk", { sensitivity: "accent" }) !==
                0),
        );
      const birthDate = dateSchema.safeParse(p.birthDate);
      const issuedBy = validIdentityIssuer(p.issuedBy) ? p.issuedBy : "";
      const row = sheet.addRow({
        name: names.join("\n"),
        sex: "Әйел",
        citizenship: p.citizenship ?? "",
        birthplace: p.birthplace ?? "",
        documentNumber:
          p.documentNumber == null ? "" : String(p.documentNumber),
        issuedBy,
        validity:
          p.issueDate || p.expiryDate
            ? validityPeriod(p.issueDate, p.expiryDate)
            : "",
      });
      if (birthDate.success) setPaymentDate(row, "birthDate", birthDate.data);
      const number = row.getCell("documentNumber");
      number.alignment = { ...number.alignment, horizontal: "center" };
      const nameLines = names.reduce(
        (total, name) => total + Math.ceil(name.length / 32),
        0,
      );
      row.height = Math.min(
        409,
        21 *
          Math.max(
            1,
            nameLines,
            Math.ceil(issuedBy.length / 30),
            Math.ceil((p.citizenship?.length ?? 0) / 17),
            Math.ceil((p.birthplace?.length ?? 0) / 24),
          ),
      );
      continue;
    }
    sheet.addRow({
      ...p,
      name: documentName(p),
      region: regionLabel(p.region),
      birthYear: p.birthDate ? Number(p.birthDate.slice(0, 4)) : null,
      validity: validityPeriod(p.issueDate, p.expiryDate),
      ageLabel: p.ageGroup == null ? "" : AGE_LABELS[p.ageGroup],
      totalPaid: p.totalPaid / 100,
    });
  }
  finishTable(sheet);
}

export async function makeReport(
  type: ReportType,
  f: Filters,
  category?: ReportCategory,
) {
  const book = new ExcelJS.Workbook();
  book.creator = "Бірлік";
  book.created = new Date();
  const heading = { title: REPORT_TITLES[type], purpose: purposes[type] };
  const territory = regionLabel(f.region) || "Барлық қала мен аудан";
  if (
    ["mangystau-district", "awards", "urshyk", "international"].includes(type)
  ) {
    heading.purpose += ` Аймақ — ${territory}.`;
  }
  if (type === "members") {
    const sheet = startTable(book, "Есеп", heading, f.year, [
      { header: "Тегі", key: "lastName", width: 24 },
      { header: "Аты", key: "firstName", width: 24 },
      { header: "Латынша тегі", key: "lastNameLatin", width: 24 },
      { header: "Латынша аты", key: "firstNameLatin", width: 24 },
      { header: "Әкесінің аты", key: "middleName", width: 24 },
      { header: "Туған күні", key: "birthDate", width: 16 },
      { header: "Жасы", key: "age", width: 10 },
      { header: "Жас санаты", key: "ageLabel", width: 30 },
      { header: "Аймақ", key: "region", width: 25 },
      { header: "Елді мекен", key: "village", width: 25 },
      { header: "Телефон", key: "phone", width: 20 },
      { header: "ЖСН", key: "iin", width: 18 },
      { header: "Куәлік нөмірі", key: "documentNumber", width: 20 },
      { header: "Кім берді", key: "issuedBy", width: 40 },
      {
        header: "Жеке куәліктің жарамдылық мерзімі",
        key: "validityPeriod",
        width: 35,
      },
      { header: "Жыл", key: "year", width: 12 },
      { header: "Төленді, ₸", key: "totalPaid", width: 18, money: true },
      { header: "Қалды, ₸", key: "remaining", width: 18, money: true },
      { header: "Артық төлем, ₸", key: "overpayment", width: 18, money: true },
      { header: "Мәртебе", key: "status", width: 24 },
      { header: "Мәліметтер", key: "completeness", width: 20 },
      { header: "Ескертпе", key: "notes", width: 50 },
    ]);
    for await (const row of Participant.aggregate(memberPipeline(f)).cursor()) {
      sheet.addRow({
        ...row,
        validityPeriod: validityPeriod(row.issueDate, row.expiryDate),
        region: regionLabel(row.region),
        completeness: missingParticipantFields(row).length
          ? "Толық емес"
          : "Толық",
        year: f.year,
        totalPaid: row.totalPaid / 100,
        remaining: row.remaining / 100,
        overpayment: row.overpayment / 100,
        ageLabel:
          row.ageGroup == null
            ? "Туған күні көрсетілмеген"
            : AGE_LABELS[row.ageGroup],
        status: STATUS_LABELS[row.status as keyof typeof STATUS_LABELS],
      });
    }
    finishTable(sheet);
  } else if (type === "mangystau-oblast" || type === "mangystau-district") {
    const byRegion = type === "mangystau-district";
    if (!byRegion) await backfillRegistrationNumbers();
    const dateRange = { $gte: `${f.year}-01-01`, $lt: `${f.year + 1}-01-01` };
    const region = byRegion ? f.region : "";
    const [people, payments, otherIncome] = await Promise.all([
      Participant.find({
        deletedAt: null,
        archivedAt: null,
        siteHiddenAt: null,
        ...(region ? { region } : {}),
      })
        .select(reportPersonProjection)
        .lean(),
      reportPayments(
        {
          paymentDate: dateRange,
          ...(byRegion
            ? {
                paymentKind: "additional",
                ...(category
                  ? { paymentCategoryId: new Types.ObjectId(category.id) }
                  : {}),
              }
            : {}),
        },
        region,
      ),
      !byRegion
        ? Finance.find({ type: "income", voidedAt: null, date: dateRange })
            .sort({ date: -1, _id: -1 })
            .select("date category amount description")
            .lean()
        : undefined,
    ]);
    if (byRegion)
      heading.purpose += category
        ? ` Төлем түрі — ${category.name}.`
        : " Барлық қосымша төлем түрлері қамтылған.";
    addPaymentTables(book, heading, f.year, payments, {
      people,
      byRegion,
      category: byRegion ? category : undefined,
      otherIncome,
    });
  } else if (
    type === "awards" ||
    type === "urshyk" ||
    type === "international"
  ) {
    await addRoster(book, type, heading, f);
  } else if (type === "payments") {
    // The unfiltered ledger includes tombstones (archive state is cleared
    // on deletion). Personal filters only apply to identifiable profiles.
    const overall =
      f.archived !== "true" && !f.region && !f.age && !f.q.trim() && !f.status;
    const memberIds = overall
      ? await Participant.distinct("_id", { archivedAt: null })
      : (
          await Participant.aggregate([
            ...memberPipeline(f),
            { $project: { _id: 1 } },
          ])
        ).map((m) => m._id);
    const payments = await reportPayments({
      year: f.year,
      participantId: { $in: memberIds },
    });
    addPaymentTables(book, heading, f.year, payments);
  } else if (type === "financial") {
    const summary = await financialSummary(f.year);
    const sheet = startTable(book, "Есеп", heading, f.year, [
      { header: "Көрсеткіш", key: "label", width: 45 },
      { header: "Сома, ₸", key: "amount", width: 25, money: true },
    ]);
    for (const [key, label] of Object.entries({
      membership: "Мүшелік жарналар",
      additional: "Қосымша төлемдер",
      income: "Өзге кірістер",
      totalIncome: "Жалпы кіріс",
      expense: "Жалпы шығыс",
      balance: "Есептік қалдық",
    }))
      sheet.addRow({ label, amount: (summary as any)[key] / 100 });
    finishTable(sheet);
  } else {
    const sheet = startTable(book, "Есеп", heading, f.year, [
      { header: "Күні мен уақыты (Астана)", key: "date", width: 25 },
      { header: "Санат", key: "category", width: 28 },
      { header: "Сома, ₸", key: "amount", width: 20, money: true },
      { header: "Түсініктеме", key: "description", width: 50 },
    ]);
    const dateRange = { $gte: `${f.year}-01-01`, $lt: `${f.year + 1}-01-01` };
    const manual = await Finance.find({
      type,
      voidedAt: null,
      date: dateRange,
    }).lean();
    const entries = manual.map((row) => ({
      day: row.date || "",
      time: "",
      category: row.category,
      description: row.description,
      amount: row.amount || 0,
    }));
    if (type === "income") {
      const received = await Payment.find({
        voidedAt: null,
        paymentDate: dateRange,
      }).lean();
      for (const row of received)
        entries.push({
          day: row.paymentDate || "",
          time: row.paymentTime || "",
          category: paymentCategoryLabel(row),
          description: row.recipientName,
          amount: row.amount || 0,
        });
    }
    entries.sort(
      (a, b) => b.day.localeCompare(a.day) || b.time.localeCompare(a.time),
    );
    for (const entry of entries) {
      const row = sheet.addRow({ ...entry, amount: entry.amount / 100 });
      setPaymentDate(row, "date", entry.day, entry.time);
    }
    finishTable(sheet);
  }
  return book.xlsx.writeBuffer();
}
