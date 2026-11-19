import ExcelJS from "exceljs";
import { Participant, Payment, Finance } from "../models.js";
import { memberPipeline, type Filters } from "./members.js";
import {
  AGE_LABELS,
  STATUS_LABELS,
  missingParticipantFields,
} from "../../shared/domain.js";
export async function financialSummary(year: number) {
  const from = `${year}-01-01`,
    to = `${year + 1}-01-01`;
  const [members, other, months, memberMonths] = await Promise.all([
    Payment.aggregate([
      { $match: { voidedAt: null, paymentDate: { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
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
          _id: { $substrBytes: ["$paymentDate", 5, 2] },
          total: { $sum: "$amount" },
        },
      },
    ]),
  ]);
  const membership = members[0]?.total || 0,
    income = other.find((x) => x._id === "income")?.total || 0,
    expense = other.find((x) => x._id === "expense")?.total || 0;
  return {
    membership,
    income,
    expense,
    totalIncome: membership + income,
    balance: membership + income - expense,
    months: Array.from({ length: 12 }, (_, i) => {
      const key = String(i + 1).padStart(2, "0");
      return {
        month: i + 1,
        membership: memberMonths.find((x) => x._id === key)?.total || 0,
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
export const reportTypes = [
  "members",
  "payments",
  "income",
  "expense",
  "financial",
] as const;
export async function makeReport(type: string, f: Filters) {
  const book = new ExcelJS.Workbook();
  book.creator = "Бірлік";
  book.created = new Date();
  const sheet = book.addWorksheet("Есеп");
  if (type === "members") {
    sheet.columns = [
      { header: "Тегі", key: "lastName", width: 24 },
      { header: "Аты", key: "firstName", width: 24 },
      { header: "Әкесінің аты", key: "middleName", width: 24 },
      { header: "Туған күні", key: "birthDate", width: 16 },
      { header: "Жасы", key: "age", width: 10 },
      { header: "Жас санаты", key: "ageLabel", width: 30 },
      { header: "Аймақ", key: "region", width: 25 },
      { header: "Телефон", key: "phone", width: 20 },
      { header: "ЖСН", key: "iin", width: 18 },
      { header: "Куәлік нөмірі", key: "documentNumber", width: 20 },
      { header: "Кім берді", key: "issuedBy", width: 40 },
      { header: "Берілген күні", key: "issueDate", width: 18 },
      { header: "Жарамдылық мерзімі", key: "expiryDate", width: 22 },
      { header: "Жыл", key: "year", width: 12 },
      { header: "Төленді, ₸", key: "totalPaid", width: 18 },
      { header: "Қалды, ₸", key: "remaining", width: 18 },
      { header: "Артық төлем, ₸", key: "overpayment", width: 18 },
      { header: "Мәртебе", key: "status", width: 24 },
      { header: "Мәліметтер", key: "completeness", width: 20 },
      { header: "Ескертпе", key: "notes", width: 50 },
    ];
    for await (const row of Participant.aggregate(memberPipeline(f)).cursor()) {
      sheet.addRow({
        ...row,
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
  } else if (type === "payments") {
    sheet.columns = [
      { header: "Қатысушы", key: "name", width: 35 },
      { header: "Жарна жылы", key: "year", width: 16 },
      { header: "Төлем күні", key: "paymentDate", width: 18 },
      { header: "Сома, ₸", key: "amount", width: 20 },
      { header: "Алушы", key: "recipientName", width: 30 },
      { header: "Чек нөмірі", key: "receiptNumber", width: 25 },
    ];
    const members = await Participant.aggregate([
      ...memberPipeline(f),
      { $project: { _id: 1 } },
    ]);
    for await (const row of Payment.find({
      year: f.year,
      voidedAt: null,
      participantId: { $in: members.map((m) => m._id) },
    })
      .populate("participantId")
      .lean()
      .cursor()) {
      const p: any = row.participantId;
      sheet.addRow({
        ...row,
        name: [p.lastName, p.firstName, p.middleName].filter(Boolean).join(" "),
        amount: row.amount! / 100,
      });
    }
  } else if (type === "financial") {
    const summary = await financialSummary(f.year);
    sheet.columns = [
      { header: "Көрсеткіш", key: "label", width: 45 },
      { header: "Сома, ₸", key: "amount", width: 25 },
    ];
    for (const [key, label] of Object.entries({
      membership: "Мүшелік жарналар",
      income: "Өзге кірістер",
      totalIncome: "Жалпы кіріс",
      expense: "Жалпы шығыс",
      balance: "Есептік қалдық",
    }))
      sheet.addRow({ label, amount: (summary as any)[key] / 100 });
    sheet.addRow({ label: "Жыл", amount: f.year });
  } else {
    sheet.columns = [
      { header: "Күні", key: "date", width: 18 },
      { header: "Санат", key: "category", width: 28 },
      { header: "Сома, ₸", key: "amount", width: 20 },
      { header: "Түсініктеме", key: "description", width: 50 },
    ];
    if (type === "income") {
      for await (const row of Payment.find({
        voidedAt: null,
        paymentDate: { $gte: `${f.year}-01-01`, $lt: `${f.year + 1}-01-01` },
      })
        .sort({ paymentDate: -1 })
        .lean()
        .cursor()) {
        sheet.addRow({
          date: row.paymentDate,
          category: "Мүшелік жарна",
          amount: row.amount! / 100,
          description: row.recipientName || "",
        });
      }
    }
    for await (const row of Finance.find({
      type,
      voidedAt: null,
      date: { $gte: `${f.year}-01-01`, $lt: `${f.year + 1}-01-01` },
    })
      .sort({ date: -1 })
      .lean()
      .cursor())
      sheet.addRow({ ...row, amount: row.amount! / 100 });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF173F35" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount },
  };
  return book.xlsx.writeBuffer();
}
