import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import mongoose from "mongoose";
import { z } from "zod";
import { Participant, Payment, Audit, ImportDraft } from "../models.js";
import {
  participantSchema,
  missingParticipantFields,
  paymentSchema,
  REGIONS,
  parseMoney,
  type ParticipantInput,
} from "../../shared/domain.js";
import { normalizeParticipant } from "./members.js";
import { regionLabel } from "../../shared/locations.js";

export const IMPORT_COLUMNS = {
  notes: ["Ескертпе", "Примечание", "notes"],
  village: [
    "Елді мекен",
    "Ауыл",
    "Село",
    "Поселок",
    "Населенный пункт",
    "village",
  ],
  lastName: ["Тегі", "Фамилия", "surname", "lastName"],
  firstName: ["Аты", "Имя", "name", "firstName"],
  middleName: ["Әкесінің аты", "Отчество", "middleName"],
  fullName: ["Аты-жөні", "ФИО", "Ф.И.О.", "Фамилия имя отчество", "АӘТ"],
  fullNameLatin: ["Ағылшын аты жөні", "Латынша аты-жөні"],
  validityPeriod: [
    "Жеке куәліктің жарамдылық мерзімі",
    "Куәліктің мерзімі (басталуы–аяқталуы)",
  ],
  birthDate: ["Туған күні", "Дата рождения", "birthDate"],
  region: [
    "Аймақ",
    "Аймағы",
    "Регион",
    "Район",
    "region",
    "Мекен жай",
    "Мекенжай",
  ],
  phone: ["Телефон", "Телефон нөмірі", "Номер телефона", "phone"],
  iin: ["ЖСН", "ИИН", "iin"],
  documentNumber: [
    "Куәлік нөмірі",
    "Жеке куәлік номері",
    "Жеке куәлік нөмірі",
    "Номер удостоверения",
    "Номер документа",
    "documentNumber",
  ],
  issuedBy: ["Кім берді", "Кем выдан", "Орган выдачи", "issuedBy"],
  issueDate: [
    "Жарамдылық мерзімінің басталуы",
    "Берілген күні",
    "Дата выдачи",
    "issueDate",
  ],
  expiryDate: [
    "Жарамдылық мерзімінің аяқталуы",
    "Жарамдылық мерзімі",
    "Срок действия",
    "Действителен до",
    "expiryDate",
  ],
  lastNameLatin: ["Латынша тегі", "Фамилия латиницей", "lastNameLatin"],
  firstNameLatin: ["Латынша аты", "Имя латиницей", "firstNameLatin"],
  amount: ["Төленді, ₸", "Төленді", "Оплачено", "Сумма взноса", "amount"],
  year: ["Жыл", "Жарна жылы", "Год взноса", "year"],
  paymentDate: ["Төлем күні", "Дата платежа", "paymentDate"],
  paymentTime: ["Төлем уақыты", "Время платежа", "paymentTime"],
} as const;
type Key = keyof typeof IMPORT_COLUMNS;
type Mapping = Partial<Record<Key, number>>;
type ReadyRow = {
  row: number;
  importKey: string;
  participant: ParticipantInput;
  payment?: z.infer<typeof paymentSchema>;
};
export class ImportError extends Error {
  status = 400;
}
const REGION_ALIASES: Record<string, string[]> = {
  Ақтау: ["Актау", "г. Актау"],
  Жаңаөзен: ["Жанаозен", "г. Жанаозен"],
  "Бейнеу ауданы": ["Бейнеуский район"],
  "Қарақия ауданы": ["Каракиянский район"],
  "Маңғыстау ауданы": ["Мангистауский район"],
  "Мұнайлы ауданы": ["Мунайлинский район"],
  "Түпқараған ауданы": ["Тупкараганский район"],
};
const normal = (s: string) =>
  s
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\s.,₸_()-]/g, "");
export const personKey = (
  p: Pick<ParticipantInput, "lastName" | "firstName" | "birthDate">,
) =>
  createHash("sha256")
    .update([normal(p.lastName), normal(p.firstName), p.birthDate].join("|"))
    .digest("hex");
function keys(p: any) {
  return [
    ...(p.lastName && p.firstName && p.birthDate
      ? ["person:" + personKey(p)]
      : []),
    ...(p.importKey ? ["source:" + p.importKey] : []),
    ...(p.iin ? ["iin:" + p.iin] : []),
    ...(p.documentNumber ? ["doc:" + normal(p.documentNumber)] : []),
  ];
}
async function existingKeys(session?: mongoose.ClientSession) {
  const set = new Set<string>();
  const query = Participant.find()
    .select("lastName firstName birthDate iin documentNumber importKey")
    .lean();
  if (session) query.session(session);
  for (const p of await query) for (const k of keys(p)) set.add(k);
  return set;
}
// Reject oversized expanded workbooks before ExcelJS decompresses their contents.
function checkArchive(buffer: Buffer) {
  let end = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--)
    if (buffer.readUInt32LE(p) === 0x06054b50) {
      end = p;
      break;
    }
  if (end < 0)
    throw new ImportError(
      "Бұл XLSX файлы емес. Excel-де .xlsx түрінде сақтаңыз.",
    );
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16),
    size = 0;
  if (count > 1500 || count === 0 || cursor >= buffer.length)
    throw new ImportError("Excel файлы тым күрделі немесе бүлінген.");
  for (let i = 0; i < count; i++) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      throw new ImportError("Excel файлы бүлінген.");
    const bytes = buffer.readUInt32LE(cursor + 24);
    if (buffer.readUInt16LE(cursor + 8) & 1 || bytes === 0xffffffff)
      throw new ImportError(
        "Құпиясөзбен қорғалған немесе ZIP64 файлы қабылданбайды.",
      );
    const compressed = buffer.readUInt32LE(cursor + 20),
      local = buffer.readUInt32LE(cursor + 42);
    const method = buffer.readUInt16LE(cursor + 10);
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50)
      throw new ImportError("Excel файлы бүлінген.");
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length || ![0, 8].includes(method))
      throw new ImportError("Excel файлының пішімі қолдау таппайды.");
    try {
      const raw = buffer.subarray(start, start + compressed);
      const actual =
        method === 8
          ? inflateRawSync(raw, { maxOutputLength: 50 * 1024 * 1024 - size })
              .length
          : raw.length;
      if (actual !== bytes) throw new Error("invalid size");
    } catch {
      throw new ImportError(
        "Excel файлы бүлінген немесе ашылған көлемі тым үлкен.",
      );
    }
    size += bytes;
    if (size > 50 * 1024 * 1024)
      throw new ImportError(
        "Excel файлының ашылған көлемі 50 МБ-тан аспауы керек.",
      );
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
}
function cellString(cell: ExcelJS.Cell, key: Key, date1904: boolean) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (
    typeof value === "object" &&
    ("formula" in value || "sharedFormula" in value)
  )
    throw new Error("формуланы мәнге ауыстырыңыз");
  if (key === "paymentTime") {
    if (value instanceof Date) return value.toISOString().slice(11, 19);
    if (typeof value === "number" && value >= 0 && value < 1) {
      const seconds = Math.round(value * 86400) % 86400;
      return [
        Math.floor(seconds / 3600),
        Math.floor(seconds / 60) % 60,
        seconds % 60,
      ]
        .map((n) => String(n).padStart(2, "0"))
        .join(":");
    }
    return cell.text.trim();
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (/^(?:[-–—]|жоқ|нет)$/i.test(cell.text.trim())) return "";
  if (key.endsWith("Date")) {
    if (typeof value === "number") {
      if (value < 1 || value > 100000) throw new Error("күнді тексеріңіз");
      return new Date(
        Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) +
          Math.floor(value) * 86400000,
      )
        .toISOString()
        .slice(0, 10);
    }
    const text = cell.text.trim();
    const match = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    return match
      ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`
      : text;
  }
  if (
    (key === "iin" || key === "documentNumber") &&
    typeof value === "number"
  ) {
    const width = key === "iin" ? 12 : 9;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("нөмірді мәтін түрінде енгізіңіз");
    return String(value).padStart(width, "0");
  }
  if (typeof value === "number") return String(value);
  return cell.text.trim();
}
const optionsSchema = z
  .object({
    sheet: z.coerce.number().int().min(1).optional(),
    headerRow: z.coerce.number().int().min(1).max(30).optional(),
    mapping: z.record(z.string(), z.number().int().min(1).max(100)).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    paymentDate: z.string().max(10).optional(),
  })
  .strict();
export async function previewImport(
  buffer: Buffer,
  raw: unknown,
  adminId: string,
) {
  if (buffer.length > 10 * 1024 * 1024)
    throw new ImportError("Файл 10 МБ-тан аспауы керек.");
  checkArchive(buffer);
  const options = optionsSchema.parse(raw);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(buffer as any);
  } catch {
    throw new ImportError(
      "Excel файлын оқу мүмкін болмады. .xlsx түрінде қайта сақтаңыз.",
    );
  }
  const sheets = book.worksheets.map((s) => ({ id: s.id, name: s.name }));
  const sheet = options.sheet
    ? book.getWorksheet(options.sheet)
    : book.worksheets[0];
  if (!sheet) throw new ImportError("Excel парағы табылмады.");
  if (sheet.columnCount > 100 || sheet.rowCount > 5030)
    throw new ImportError(
      "Бір файлда 5000 қатысушыға дейін және 100 бағанға дейін қабылданады.",
    );
  let headerRow = options.headerRow || 1;
  if (!options.headerRow) {
    let score = -1;
    for (let n = 1; n <= Math.min(30, sheet.rowCount); n++) {
      let found = 0;
      sheet.getRow(n).eachCell((c) => {
        if (
          Object.values(IMPORT_COLUMNS).some((names) =>
            names.some((name) => normal(name) === normal(c.text)),
          )
        )
          found++;
      });
      if (found > score) {
        score = found;
        headerRow = n;
      }
    }
  }
  const columns = Array.from({ length: sheet.columnCount }, (_, i) => ({
    index: i + 1,
    label: sheet.getCell(headerRow, i + 1).text.trim() || `Баған ${i + 1}`,
  }));
  const mapping: Mapping = {};
  for (const [key, aliases] of Object.entries(IMPORT_COLUMNS)) {
    const index = options.mapping
      ? options.mapping[key]
      : columns.find((c) => aliases.some((a) => normal(a) === normal(c.label)))
          ?.index;
    if (index && index <= sheet.columnCount) mapping[key as Key] = index;
  }
  const missing = Object.keys(mapping).some((k) =>
    [
      "lastName",
      "firstName",
      "fullName",
      "phone",
      "iin",
      "documentNumber",
    ].includes(k),
  )
    ? []
    : ["Аты-жөні, телефон немесе құжат нөмірі бар баған"];
  const fileKey = createHash("sha256").update(buffer).digest("hex");
  const rows: ReadyRow[] = [];
  const examples: any[] = [];
  const issues: { row: number; message: string }[] = [];
  let total = 0,
    duplicates = 0;
  const seen = await existingKeys();
  if (!missing.length)
    for (let n = headerRow + 1; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n);
      if (!Object.values(mapping).some((col) => row.getCell(col!).text.trim()))
        continue;
      total++;
      let data: Record<string, string> = {};
      try {
        for (const [k, col] of Object.entries(mapping))
          data[k] = cellString(
            row.getCell(col!),
            k as Key,
            Boolean(book.properties.date1904),
          );
        if (data.fullName) {
          const [lastName, firstName, ...rest] = data.fullName
            .trim()
            .split(/\s+/);
          data = {
            ...data,
            lastName: data.lastName || lastName,
            firstName: data.firstName || firstName,
            middleName: data.middleName || rest.join(" "),
          };
        }
        if (data.fullNameLatin) {
          const [last, ...first] = data.fullNameLatin.trim().split(/\s+/);
          data.lastNameLatin ||= last;
          data.firstNameLatin ||= first.join(" ");
        }
        if (data.validityPeriod) {
          const dates = data.validityPeriod.match(
            /\d{1,2}[./]\d{1,2}[./]\d{4}/g,
          );
          const iso = (v: string) => {
            const [d, m, y] = v.split(/[./]/);
            return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
          };
          if (dates?.length === 2) {
            data.issueDate ||= iso(dates[0]);
            data.expiryDate ||= iso(dates[1]);
          } else if (dates?.length === 1) {
            if (/—\s*Көрсетілмеген$/u.test(data.validityPeriod))
              data.issueDate ||= iso(dates[0]);
            else data.expiryDate ||= iso(dates[0]);
          } else {
            data.notes = [
              data.notes,
              `Куәліктің мерзімі (Excel): ${data.validityPeriod}`,
            ]
              .filter(Boolean)
              .join("\n");
          }
        }
        data.region ||= "";
        const region = REGIONS.find(
          (r) =>
            normal(r) === normal(data.region) ||
            normal(regionLabel(r)) === normal(data.region) ||
            REGION_ALIASES[r]?.some(
              (alias) => normal(alias) === normal(data.region),
            ) ||
            normal(r.replace(" ауданы", "")) ===
              normal(data.region.replace(/ район$/i, "")),
        );
        if (region) data.region = region;
        const notes = [data.notes || ""].filter(Boolean);
        if (
          data.phone &&
          !participantSchema.shape.phone.safeParse(data.phone).success
        ) {
          const number = data.phone.match(/^\+?[\d ()-]{10,20}/)?.[0].trim();
          if (
            number &&
            participantSchema.shape.phone.safeParse(number).success
          ) {
            notes.push(`Телефон (Excel): ${data.phone}`);
            data.phone = number;
          }
        }
        // Preserve annotations and invalid source values instead of inventing data.
        if (data.documentNumber && !/\d/.test(data.documentNumber)) {
          notes.push(`Куәлік нөмірі (Excel): ${data.documentNumber}`);
          data.documentNumber = "";
        }
        for (const [key, schema] of Object.entries(participantSchema.shape)) {
          if (key === "notes" || !data[key]) continue;
          if (!schema.safeParse(data[key]).success) {
            notes.push(
              `${IMPORT_COLUMNS[key as Key]?.[0] || key} (Excel): ${data[key]}`,
            );
            data[key] = "";
          }
        }
        if (
          data.issueDate &&
          data.expiryDate &&
          data.issueDate > data.expiryDate
        ) {
          notes.push(
            `Куәліктің мерзімі (Excel): ${data.issueDate} — ${data.expiryDate}`,
          );
          data.issueDate = data.expiryDate = "";
        }
        data.notes = notes.join("\n");
        const participant = participantSchema.parse(data);
        let payment: ReadyRow["payment"];
        if (mapping.amount && data.amount && parseMoney(data.amount) > 0) {
          payment = paymentSchema.parse({
            amount: parseMoney(data.amount),
            year: Number(data.year || options.year),
            paymentDate: data.paymentDate || options.paymentDate,
            paymentTime: data.paymentTime || "",
            method: "Excel",
            notes: "Excel арқылы енгізілді",
          });
        }
        const importKey =
          "row:" +
          createHash("sha256")
            .update(`${fileKey}|${sheet.id}|${n}`)
            .digest("hex");
        const rowKeys = keys({ ...participant, importKey });
        const duplicate = rowKeys.some((k) => seen.has(k));
        if (duplicate) duplicates++;
        else {
          rows.push({ row: n, importKey, participant, payment });
          rowKeys.forEach((k) => seen.add(k));
        }
        if (examples.length < 50)
          examples.push({
            row: n,
            name: [
              participant.lastName,
              participant.firstName,
              participant.middleName,
            ]
              .filter(Boolean)
              .join(" "),
            birthDate: participant.birthDate,
            region: participant.region,
            phone: participant.phone,
            documentNumber: participant.documentNumber,
            amount: payment?.amount || 0,
            status: duplicate ? "duplicate" : "ready",
            missingFields: missingParticipantFields(participant),
            notes: participant.notes,
          });
      } catch (error) {
        const message =
          error instanceof z.ZodError
            ? error.issues
                .map(
                  (i) =>
                    `${IMPORT_COLUMNS[i.path[0] as Key]?.[0] || String(i.path[0])}: ${/[А-Яа-яӘәІіҢңҒғҮүҰұҚқӨө]/.test(i.message) ? i.message : "мәні жоқ немесе дұрыс емес. Бағанды не күнді тексеріңіз"}`,
                )
                .join("; ")
            : (error as Error).message;
        issues.push({ row: n, message });
        if (examples.length < 50)
          examples.push({
            row: n,
            name: [data.lastName, data.firstName].filter(Boolean).join(" "),
            status: "error",
            message,
          });
      }
    }
  let draftId: string | undefined;
  if (!missing.length && !issues.length && rows.length) {
    const draft = await ImportDraft.create({
      adminId,
      rows,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    draftId = String(draft._id);
  }
  return {
    sheets,
    sheet: sheet.id,
    headerRow,
    columns,
    mapping,
    fields: Object.entries(IMPORT_COLUMNS).map(([key, names]) => ({
      key,
      label: names[0],
    })),
    missing,
    total,
    ready: rows.length,
    incomplete: rows.filter(
      (r) => missingParticipantFields(r.participant).length > 0,
    ).length,
    duplicates,
    errorCount: issues.length,
    issues: issues.slice(0, 100),
    examples,
    draftId,
  };
}
export async function commitImport(id: string, adminId: string) {
  if (!mongoose.isValidObjectId(id))
    throw new ImportError("Импорт нөмірі дұрыс емес.");
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const draft = await ImportDraft.findOne({
        _id: id,
        adminId,
        expiresAt: { $gt: new Date() },
      }).session(session);
      if (!draft)
        throw new ImportError(
          "Алдын ала қарау мерзімі аяқталды. Файлды қайта жүктеңіз.",
        );
      if (draft.status === "applied") return draft.result;
      // Claim the draft inside the transaction: simultaneous clicks return the same result.
      await ImportDraft.updateOne(
        { _id: id },
        { $set: { status: "applying" } },
        { session },
      );
      const seen = await existingKeys(session);
      const inserted: any[] = [];
      const payments: any[] = [];
      let skipped = 0;
      for (const entry of draft.rows as ReadyRow[]) {
        const person = participantSchema.parse(entry.participant);
        const importKey = entry.importKey || personKey(person);
        const rowKeys = keys({ ...person, importKey });
        if (rowKeys.some((k) => seen.has(k))) {
          skipped++;
          continue;
        }
        rowKeys.forEach((k) => seen.add(k));
        const _id = new mongoose.Types.ObjectId();
        inserted.push({
          _id,
          ...normalizeParticipant(person),
          importKey,
        });
        if (entry.payment)
          payments.push({
            ...paymentSchema.parse(entry.payment),
            participantId: _id,
          });
      }
      if (inserted.length) await Participant.insertMany(inserted, { session });
      if (payments.length) await Payment.insertMany(payments, { session });
      const result = {
        created: inserted.length,
        payments: payments.length,
        skipped,
      };
      await Audit.create(
        [
          {
            adminId,
            action: "import-excel",
            entity: "ImportDraft",
            entityId: draft._id,
            after: { ...result, participantIds: inserted.map((p) => p._id) },
          },
        ],
        { session },
      );
      await ImportDraft.updateOne(
        { _id: id },
        { $set: { status: "applied", result, rows: [] } },
        { session },
      );
      return result;
    });
  } finally {
    await session.endSession();
  }
}
export async function importTemplate() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Қатысушылар");
  sheet.columns = Object.entries(IMPORT_COLUMNS)
    .filter(([k]) => k !== "fullName")
    .map(([key, names]) => ({ header: names[0], key, width: 24 }));
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const key of ["iin", "documentNumber", "phone"])
    sheet.getColumn(key).numFmt = "@";
  const help = book.addWorksheet("Нұсқаулық");
  help.getColumn(1).width = 110;
  [
    "Бірінші параққа өз қатысушыларыңызды енгізіңіз. Дайын мысал деректер жоқ.",
    "Белгісіз мәліметтерді бос қалдырыңыз: қатысушы «Толық емес» белгісімен қосылады. Кемінде аты-жөні, телефон немесе құжат нөмірі қажет.",
    "Күн пішімі: КК.АА.ЖЖЖЖ немесе Excel күні.",
    "Куәлік мәліметтері белгісіз болса, бос қалдырыңыз. ЖСН мен құжат нөмірі — мәтін.",
    "Төлем енгізсеңіз: Төленді, ₸; Жыл; Төлем күні бағандарын толтырыңыз.",
    "Қайталанған адам жаңадан қосылмайды. Бұрынғы мәліметтер өзгермейді.",
    "Аймақтар: " + REGIONS.join(", "),
  ].forEach((text) => help.addRow([text]));
  return book.xlsx.writeBuffer();
}
