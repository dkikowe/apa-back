import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mongoose from "mongoose";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import {
  Admin,
  Participant,
  Payment,
  PaymentCategory,
  Finance,
  Document,
  Audit,
} from "./models.js";
import {
  participantSchema,
  paymentSchema,
  paymentCategorySchema,
  MEMBERSHIP_PAYMENT_LABEL,
  financeSchema,
} from "../shared/domain.js";
import {
  filtersSchema,
  listMembers,
  memberPipeline,
  normalizeParticipant,
} from "./services/members.js";
import { reportFilename } from "../shared/report-names.js";
import { statistics, makeReport, reportTypes } from "./services/reports.js";
import { storage } from "./services/storage.js";
import {
  DuplicateError,
  participantConflict,
  paymentConflict,
  receiptKey,
  savedDocumentConflict,
  currentDocumentDuplicate,
  savedPaymentConflict,
  resumeDraft,
  newReadCycle,
  needsReaderUpgrade,
  readerVersion,
  uploadResult,
} from "./services/duplicates.js";
import {
  documentReadState,
  originalFileMissing,
} from "./services/document-errors.js";
import { extractReceiptText } from "./services/document-fields.js";
import {
  previewImport,
  commitImport,
  importTemplate,
  ImportError,
} from "./services/imports.js";
declare module "express-session" {
  interface SessionData {
    adminId: string;
    csrf: string;
  }
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}
// A failed replacement must never inherit the previous attachment's form values.
// The first upload can still be entered manually after an ordinary read failure.
function checkFailedAttachment(
  doc: Parameters<typeof documentReadState>[0],
  nextId: string,
  previousId?: string,
) {
  if (doc.status !== "failed" || nextId === previousId) return;
  const { wrongDocumentKind, permanentReadFailure, error } =
    documentReadState(doc);
  if (wrongDocumentKind || permanentReadFailure || previousId)
    throw new HttpError(400, error || "Құжат оқылмады. Файлды қайта таңдаңыз.");
}
async function checkDocumentDuplicate(
  doc: any,
  session: mongoose.ClientSession,
) {
  if (doc.status !== "duplicate") return;
  const duplicate = await currentDocumentDuplicate(doc, session);
  if (duplicate) throw new DuplicateError(duplicate);
  if (needsReaderUpgrade({ ...doc.toObject(), status: "done" }))
    throw new HttpError(400, "Құжат тексеріліп жатыр. Күте тұрыңыз.");
  await Document.updateOne(
    { _id: doc._id, status: "duplicate" },
    { $set: { status: "done" }, $unset: { duplicate: 1, error: 1 } },
    { session },
  );
}
const documentStatusFields =
  "kind status fields error wrongDocumentKind permanentReadFailure duplicate participantId mime originalName size attempts recognitionVersion recoveryStage recoveryHasCheckpoint nextReadAt hash";

async function publicDocumentStatus({ hash, ...doc }: any) {
  if (doc.status === "duplicate") {
    const duplicate = await currentDocumentDuplicate({ ...doc, hash });
    if (!duplicate) {
      // A previously conflicting record can be deleted while the form is open.
      // Resume any missing fields before the released upload can be attached.
      const released = { ...doc, status: "done", error: null };
      const update = needsReaderUpgrade(released)
        ? { ...newReadCycle, recognitionVersion: readerVersion(doc.kind) }
        : { status: "done" };
      await Document.updateOne(
        { _id: doc._id, status: "duplicate" },
        { $set: update, $unset: { duplicate: 1, error: 1, recognitionKey: 1 } },
      );
      const current = await Document.findById(doc._id)
        .select(documentStatusFields)
        .lean();
      if (!current) throw new HttpError(404, "Құжат табылмады.");
      const { hash: _hash, ...result } = current;
      return { ...result, ...documentReadState(result) };
    }
    doc = { ...doc, duplicate, error: duplicate.message };
  }
  return { ...doc, ...documentReadState(doc) };
}
const checkId = (id: string) => {
  if (!mongoose.isValidObjectId(id))
    throw new HttpError(400, "Жазба нөмірі дұрыс емес.");
  return id;
};
async function audit(
  adminId: string,
  action: string,
  entity: string,
  entityId: any,
  before: any,
  after: any,
  s: mongoose.ClientSession,
) {
  await Audit.create([{ adminId, action, entity, entityId, before, after }], {
    session: s,
  });
}
async function atomic<T>(fn: (s: mongoose.ClientSession) => Promise<T>) {
  const s = await mongoose.startSession();
  try {
    return await s.withTransaction(() => fn(s));
  } finally {
    await s.endSession();
  }
}
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.production) app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'"],
          "frame-src": ["'self'", "blob:"],
          "upgrade-insecure-requests": config.production ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(
    session({
      name: "birlik.sid",
      secret: config.secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      store: MongoStore.create({
        mongoUrl: config.mongo,
        collectionName: "sessions",
        serialize: JSON.stringify,
        unserialize: (data: any) => data,
        ttl: 8 * 60 * 60,
        crypto: {
          secret:
            "Aa1!" +
            createHash("sha256").update(config.secret).digest("base64"),
        },
      }),
      cookie: {
        httpOnly: true,
        secure: config.production,
        sameSite: "strict",
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  app.get("/api/health", (_req, res) =>
    res
      .status(mongoose.connection.readyState === 1 ? 200 : 503)
      .json({ ok: mongoose.connection.readyState === 1 }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin && origin !== config.origin)
        return next(new HttpError(403, "Сұрау рұқсат етілмеген."));
      if (
        req.path !== "/auth/login" &&
        (!req.session.csrf || req.get("x-csrf-token") !== req.session.csrf)
      )
        return next(new HttpError(403, "Бетті жаңартып, қайталап көріңіз."));
    }
    next();
  });
  app.post(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 8,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        message: "Көп рет қате енгізілді. 15 минуттан кейін көріңіз.",
      },
    }),
    async (req, res) => {
      const data = z
        .object({
          username: z.string().min(1).max(100),
          password: z.string().min(1).max(200),
        })
        .parse(req.body);
      const admin = await Admin.findOne({ username: data.username });
      const valid = await bcrypt.compare(
        data.password,
        admin?.passwordHash ||
          "$2b$12$ZVwcaEObp67z2C40c/4FYO6vVPZGK2LH3kLT4amvv5tXIRWSwzQ9e",
      );
      if (!admin || !valid)
        throw new HttpError(401, "Логин немесе құпиясөз дұрыс емес.");
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((e) => (e ? reject(e) : resolve())),
      );
      req.session.adminId = String(admin._id);
      req.session.csrf = randomBytes(32).toString("hex");
      await new Promise<void>((resolve, reject) =>
        req.session.save((e) => (e ? reject(e) : resolve())),
      );
      res.json({ username: admin.username, csrf: req.session.csrf });
    },
  );
  app.use("/api", (req, res, next) => {
    if (!req.session.adminId)
      return res.status(401).json({ message: "Жүйеге кіріңіз." });
    res.set("Cache-Control", "no-store");
    next();
  });
  app.post(
    "/api/receipts/recognize-text",
    rateLimit({ windowMs: 60_000, limit: 30 }),
    async (req, res) => {
      const { text, paymentId } = z
        .object({
          text: z.string().trim().min(1).max(20000),
          paymentId: z
            .string()
            .regex(/^[a-f\d]{24}$/i)
            .optional(),
        })
        .parse(req.body);
      try {
        const fields = extractReceiptText(text);
        const duplicate = await paymentConflict(
          String(fields.receiptNumber || ""),
          undefined,
          paymentId,
        );
        if (duplicate) throw new DuplicateError(duplicate);
        res.json({ fields });
      } catch (error) {
        if (error instanceof DuplicateError) throw error;
        throw new HttpError(400, (error as Error).message);
      }
    },
  );
  app.get("/api/auth/me", async (req, res) => {
    const admin = await Admin.findById(req.session.adminId).select("username");
    if (!admin) throw new HttpError(401, "Жүйеге қайта кіріңіз.");
    res.json({ username: admin.username, csrf: req.session.csrf });
  });
  app.post("/api/auth/logout", async (req, res) => {
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((e) => (e ? reject(e) : resolve())),
    );
    res.clearCookie("birlik.sid", {
      httpOnly: true,
      sameSite: "strict",
      secure: config.production,
    });
    res.json({ ok: true });
  });
  app.get("/api/participants/import/template", async (_req, res) => {
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename=participants-template.xlsx",
    });
    res.send(Buffer.from(await importTemplate()));
  });
  app.post(
    "/api/participants/import/preview",
    rateLimit({
      windowMs: 60_000,
      limit: 15,
      message: { message: "Бір минуттан кейін қайталаңыз." },
    }),
    multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
        fields: 1,
        fieldSize: 16384,
      },
    }).single("file"),
    async (req, res) => {
      if (!req.file || !/\.xlsx$/i.test(req.file.originalname))
        throw new ImportError("Excel .xlsx файлын таңдаңыз.");
      let options: unknown = {};
      try {
        options = JSON.parse(req.body.options || "{}");
      } catch {
        throw new ImportError("Импорт бағандарын қайта таңдаңыз.");
      }
      res.json(
        await previewImport(req.file.buffer, options, req.session.adminId!),
      );
    },
  );
  app.post("/api/participants/import/:id/commit", async (req, res) =>
    res.json(await commitImport(req.params.id, req.session.adminId!)),
  );
  app.get("/api/participants", async (req, res) =>
    res.json(await listMembers(filtersSchema.parse(req.query))),
  );
  app.post("/api/participants", async (req, res) => {
    const data = participantSchema.parse(req.body);
    const result = await atomic(async (s) => {
      const conflict = await participantConflict(data.iin, undefined, s);
      if (conflict) throw new DuplicateError(conflict);
      if (data.identityDocumentId) {
        if (!data.iin)
          throw new HttpError(
            400,
            "Қайталануын тексеру үшін куәліктегі 12 таңбалы ЖСН қажет.",
          );
        const doc = await Document.findOne({
          _id: data.identityDocumentId,
          kind: "identity",
          ownerId: req.session.adminId,
          participantId: null,
        }).session(s);
        if (!doc)
          throw new HttpError(
            400,
            "Құжат табылмады немесе басқа адамға тіркелген.",
          );
        checkFailedAttachment(doc, data.identityDocumentId);
        await checkDocumentDuplicate(doc, s);
        if (["queued", "processing"].includes(doc.status!))
          throw new HttpError(400, "Құжат тексеріліп жатыр. Күте тұрыңыз.");
      }
      const [p] = await Participant.create([normalizeParticipant(data)], {
        session: s,
      });
      if (data.identityDocumentId)
        await Document.updateOne(
          { _id: data.identityDocumentId },
          { $set: { participantId: p._id } },
          { session: s },
        );
      await audit(
        req.session.adminId!,
        "create",
        "Participant",
        p._id,
        null,
        p.toObject(),
        s,
      );
      return p;
    });
    res.status(201).json(result);
  });
  app.get("/api/participants/:id", async (req, res) => {
    const [p] = await Participant.aggregate(
      memberPipeline(
        filtersSchema.parse({ year: req.query.year }),
        checkId(req.params.id),
      ),
    );
    if (!p) throw new HttpError(404, "Қатысушы табылмады.");
    const payments = await Payment.find({ participantId: p._id })
      .sort({ paymentDate: -1, paymentTime: -1, createdAt: -1, _id: -1 })
      .lean();
    res.json({ ...p, payments });
  });
  app.patch("/api/participants/:id", async (req, res) => {
    const id = checkId(req.params.id);
    const input = z.record(z.string(), z.unknown()).parse(req.body);
    const previous = z
      .record(z.string(), z.string())
      .optional()
      .parse(input.previousValues);
    const p = await atomic(async (s) => {
      const before = await Participant.findOne({
        _id: id,
        deletedAt: null,
        siteHiddenAt: null,
      }).session(s);
      if (!before) throw new HttpError(404, "Қатысушы табылмады.");
      // Merge against the current row inside the transaction. A form can
      // remain open while OCR fills a date or another admin edits a field.
      const merged: Record<string, unknown> = {};
      for (const key of Object.keys(participantSchema.shape)) {
        const stored = before.get(key);
        const current = stored == null ? "" : String(stored);
        if (stored != null) merged[key] = current;
        if (!Object.hasOwn(input, key)) continue;
        if (previous && Object.hasOwn(previous, key)) {
          if (input[key] === previous[key]) continue;
          if (current !== previous[key] && current !== input[key])
            throw new HttpError(
              412,
              "Бұл мәлімет өзгертілді. Соңғы нұсқаны көру үшін терезені жауып, қайта ашыңыз.",
            );
        }
        merged[key] = input[key];
      }
      const data = participantSchema.parse(merged);
      const conflict = await participantConflict(data.iin, id, s);
      if (conflict && before.iin !== data.iin)
        throw new DuplicateError(conflict);
      const normalized = normalizeParticipant(data);
      if (conflict) delete normalized.iinKey;
      if (data.identityDocumentId) {
        if (!data.iin)
          throw new HttpError(
            400,
            "Қайталануын тексеру үшін куәліктегі 12 таңбалы ЖСН қажет.",
          );
        const doc = await Document.findOne({
          _id: data.identityDocumentId,
          kind: "identity",
          ownerId: req.session.adminId,
          $or: [{ participantId: null }, { participantId: id }],
        }).session(s);
        if (!doc) throw new HttpError(400, "Құжат табылмады.");
        checkFailedAttachment(
          doc,
          data.identityDocumentId,
          before.identityDocumentId?.toString(),
        );
        await checkDocumentDuplicate(doc, s);
        if (
          ["queued", "processing"].includes(doc.status!) &&
          (String(before.identityDocumentId) !== data.identityDocumentId ||
            before.iin !== data.iin)
        )
          throw new HttpError(400, "Құжат тексеріліп жатыр. Күте тұрыңыз.");
        await Document.updateOne(
          { _id: doc._id },
          { $set: { participantId: id } },
          { session: s },
        );
      }
      const after = await Participant.findOneAndUpdate(
        { _id: id, deletedAt: null, siteHiddenAt: null },
        {
          $set: {
            ...normalized,
          },
          ...(!data.iin ? { $unset: { iinKey: 1 } } : {}),
        },
        { new: true, session: s },
      );
      await audit(
        req.session.adminId!,
        "update",
        "Participant",
        id,
        before.toObject(),
        after?.toObject(),
        s,
      );
      return after;
    });
    res.json(p);
  });
  app.post("/api/participants/:id/archive", async (req, res) => {
    const restore = z
      .object({ restore: z.boolean().default(false) })
      .parse(req.body).restore;
    const id = checkId(req.params.id);
    await atomic(async (s) => {
      const before = await Participant.findOne({
        _id: id,
        deletedAt: null,
        siteHiddenAt: null,
      }).session(s);
      if (!before) throw new HttpError(404, "Қатысушы табылмады.");
      const after = await Participant.findOneAndUpdate(
        { _id: id, deletedAt: null, siteHiddenAt: null },
        { $set: { archivedAt: restore ? null : new Date() } },
        { new: true, session: s },
      );
      await audit(
        req.session.adminId!,
        restore ? "restore" : "archive",
        "Participant",
        id,
        before.toObject(),
        after?.toObject(),
        s,
      );
    });
    res.json({ ok: true });
  });
  app.delete("/api/participants/:id", async (req, res) => {
    const id = checkId(req.params.id);
    await atomic(async (s) => {
      const before = await Participant.findOne({
        _id: id,
        siteHiddenAt: null,
      }).session(s);
      if (!before) throw new HttpError(404, "Қатысушы табылмады.");
      if (before.deletedAt) return;
      const deletedAt = new Date();
      const profileKeys = [
        ...Object.keys(participantSchema.shape),
        "archivedAt",
        "iinKey",
        "importKey",
        "phoneNormalized",
        "searchTokens",
      ];
      await Participant.updateOne(
        { _id: id, deletedAt: null, siteHiddenAt: null },
        {
          $set: { deletedAt },
          $unset: Object.fromEntries(profileKeys.map((key) => [key, 1])),
        },
        { session: s },
      );
      // The same identity upload can be used for a new registration. Keep
      // receipt attachments bound to their original ledger entries.
      await Document.updateMany(
        { kind: "identity", participantId: id },
        { $unset: { participantId: 1 } },
        { session: s },
      );
      await audit(
        req.session.adminId!,
        "delete",
        "Participant",
        id,
        { archivedAt: before.archivedAt ?? null },
        { deletedAt },
        s,
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/payment-categories", async (_req, res) => {
    res.json({
      items: await PaymentCategory.find()
        .sort({ createdAt: 1, _id: 1 })
        .select("name amount")
        .lean(),
    });
  });
  app.post("/api/payment-categories", async (req, res) => {
    const data = paymentCategorySchema.parse(req.body);
    const name = data.name.normalize("NFKC").replace(/\s+/g, " ");
    const nameKey = name.toLocaleLowerCase("kk-KZ");
    if (nameKey === MEMBERSHIP_PAYMENT_LABEL.toLocaleLowerCase("kk-KZ"))
      throw new HttpError(409, "Мүшелік жарна тізімде бар.");
    const created = await atomic(async (session) => {
      const [category] = await PaymentCategory.create(
        [{ name, nameKey, amount: data.amount }],
        { session },
      );
      await audit(
        req.session.adminId!,
        "create",
        "PaymentCategory",
        category._id,
        null,
        category.toObject(),
        session,
      );
      return category;
    });
    res.status(201).json(created);
  });
  // Serialize ledger mutations with deletion on the participant row. A
  // snapshot read alone would allow a new payment to commit after deletion.
  async function lockPaymentParticipant(
    id: string | mongoose.Types.ObjectId,
    s: mongoose.ClientSession,
  ) {
    const p = await Participant.findOneAndUpdate(
      { _id: id, deletedAt: null, siteHiddenAt: null },
      { $inc: { __v: 1 } },
      { session: s, timestamps: false, projection: { archivedAt: 1 } },
    ).lean();
    if (!p) throw new HttpError(404, "Қатысушы табылмады.");
    return p;
  }
  async function savePayment(req: express.Request, res: express.Response) {
    const data = paymentSchema.parse(req.body),
      id = req.params.paymentId
        ? checkId(String(req.params.paymentId))
        : undefined;
    const result = await atomic(async (s) => {
      const before = id
        ? await Payment.findOne({ _id: id, voidedAt: null }).session(s)
        : null;
      if (id && !before) throw new HttpError(404, "Төлем табылмады.");
      const participantId =
        before?.participantId || checkId(String(req.params.id));
      const participant = await lockPaymentParticipant(participantId, s);
      if (participant.archivedAt)
        throw new HttpError(400, "Алдымен қатысушыны тізімге қайтарыңыз.");
      const categoryId =
        data.paymentCategoryId ?? before?.paymentCategoryId?.toString() ?? "";
      const category = categoryId
        ? await PaymentCategory.findById(categoryId).session(s)
        : null;
      if (categoryId && !category)
        throw new HttpError(
          400,
          "Төлем түрі табылмады. Тізімнен қайта таңдаңыз.",
        );
      let fileHash: string | undefined;
      const receiptDocumentId =
        data.receiptDocumentId || before?.receiptDocumentId?.toString();
      const numberKey = receiptKey(data.receiptNumber);
      const sameSources =
        before?.receiptDocumentId?.toString() === receiptDocumentId &&
        (before?.receiptText || "") === (data.receiptText || "") &&
        receiptKey(before?.receiptNumber) === numberKey;
      if ((receiptDocumentId || data.receiptText) && !numberKey)
        throw new HttpError(400, "Қайталануын тексеру үшін чек нөмірі қажет.");
      if (data.receiptText && !sameSources) {
        let printedNumber: string;
        try {
          printedNumber = receiptKey(
            extractReceiptText(data.receiptText).receiptNumber,
          );
        } catch {
          throw new HttpError(400, "Бір чектің мәтінін ғана қойыңыз.");
        }
        if (
          (printedNumber && printedNumber !== numberKey) ||
          (receiptDocumentId && !printedNumber)
        )
          throw new HttpError(
            400,
            "Чек нөмірі мәтіндегі нөмірмен сәйкес келуі керек.",
          );
      }
      if (receiptDocumentId) {
        const doc = await Document.findOne({
          _id: receiptDocumentId,
          kind: "receipt",
          ownerId: req.session.adminId,
          $or: [{ participantId: null }, { participantId }],
        }).session(s);
        if (!doc)
          throw new HttpError(
            400,
            "Чек табылмады немесе басқа қатысушыға тіркелген.",
          );
        checkFailedAttachment(
          doc,
          receiptDocumentId,
          before?.receiptDocumentId?.toString(),
        );
        await checkDocumentDuplicate(doc, s);
        if (["queued", "processing"].includes(doc.status!) && !sameSources)
          throw new HttpError(400, "Чек тексеріліп жатыр. Күте тұрыңыз.");
        if (data.receiptText && !sameSources) {
          const fileNumber = receiptKey(doc.fields?.receiptNumber);
          if (fileNumber !== numberKey)
            throw new HttpError(
              400,
              "Файлдағы және мәтіндегі чек нөмірлерін тексеріңіз. Бір төлемге бір чек қажет.",
            );
        }
        const attachedPayment = await Payment.findOne({
          receiptDocumentId: doc._id,
          ...(id ? { _id: { $ne: id } } : {}),
        })
          .session(s)
          .lean();
        if (attachedPayment)
          throw new DuplicateError(
            await savedPaymentConflict(attachedPayment, s),
          );
        fileHash = doc.hash || undefined;
        await Document.updateOne(
          { _id: doc._id },
          { $set: { participantId } },
          { session: s },
        );
      }
      const duplicate = await paymentConflict(
        data.receiptNumber,
        fileHash,
        id,
        s,
      );
      const unchangedLegacy =
        before &&
        receiptKey(before.receiptNumber) === numberKey &&
        before.fileHash === fileHash;
      if (duplicate && !unchangedLegacy) throw new DuplicateError(duplicate);
      const keys = [
        ...(fileHash ? ["file:" + fileHash] : []),
        ...(numberKey ? ["receipt-number:" + numberKey] : []),
      ];
      const values = {
        ...data,
        participantId,
        paymentKind: category ? "additional" : "membership",
        paymentCategoryName: category?.name || MEMBERSHIP_PAYMENT_LABEL,
        ...(category ? { paymentCategoryId: category._id.toString() } : {}),
        ...(receiptDocumentId ? { receiptDocumentId } : {}),
        ...(fileHash ? { fileHash } : {}),
        ...(!duplicate && numberKey ? { receiptNumberKey: numberKey } : {}),
        ...(!duplicate && keys.length ? { dedupeKeys: keys } : {}),
      };
      if (!category) delete values.paymentCategoryId;
      let p;
      if (before) {
        p = await Payment.findByIdAndUpdate(
          id,
          {
            $set: values,
            $unset: {
              ...(!category ? { paymentCategoryId: 1 } : {}),
              fingerprint: 1,
              duplicateConfirmed: 1,
              ...(!numberKey ? { receiptNumberKey: 1 } : {}),
              ...(!fileHash ? { fileHash: 1 } : {}),
              ...(!keys.length ? { dedupeKeys: 1 } : {}),
            },
          },
          { new: true, session: s },
        );
      } else [p] = await Payment.create([values], { session: s });
      await audit(
        req.session.adminId!,
        before ? "update" : "create",
        "MembershipPayment",
        p!._id,
        before?.toObject(),
        p!.toObject(),
        s,
      );
      return p;
    });
    res.status(id ? 200 : 201).json(result);
  }
  app.post("/api/participants/:id/payments", savePayment);
  app.patch("/api/payments/:paymentId", savePayment);
  app.post("/api/payments/:id/void", async (req, res) => {
    const id = checkId(req.params.id);
    await atomic(async (s) => {
      const before = await Payment.findOne({ _id: id, voidedAt: null }).session(
        s,
      );
      if (!before) throw new HttpError(404, "Төлем табылмады.");
      await lockPaymentParticipant(before.participantId, s);
      await Payment.updateOne(
        { _id: id },
        { $set: { voidedAt: new Date() }, $unset: { dedupeKeys: 1 } },
        { session: s },
      );
      await audit(
        req.session.adminId!,
        "void",
        "MembershipPayment",
        id,
        before.toObject(),
        null,
        s,
      );
    });
    res.json({ ok: true });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 },
  });
  app.post(
    "/api/documents",
    rateLimit({
      windowMs: 60 * 1000,
      limit: 15,
      message: { message: "Бір минуттан кейін қайталап көріңіз." },
    }),
    upload.single("file"),
    async (req, res) => {
      const kind = z.enum(["identity", "receipt"]).parse(req.body.kind);
      if (!req.file) throw new HttpError(400, "Құжатты таңдаңыз.");
      const type = await fileTypeFromBuffer(req.file.buffer);
      if (
        !type ||
        !["application/pdf", "image/jpeg", "image/png"].includes(type.mime)
      )
        throw new HttpError(400, "Тек PDF, JPG және PNG файлдары қабылданады.");
      if (type.mime.startsWith("image/"))
        await sharp(req.file.buffer, { limitInputPixels: 25000000 })
          .metadata()
          .catch(() => {
            throw new HttpError(
              400,
              "Суретті ашу мүмкін емес. Басқа көшірмесін жүктеңіз.",
            );
          });
      else {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const pdf = await getDocument({
          data: new Uint8Array(req.file.buffer),
        }).promise.catch((error: unknown) => {
          if (error instanceof Error && error.name === "PasswordException")
            throw new HttpError(
              400,
              "PDF құпиясөзбен қорғалған. Ашық көшірмесін жүктеңіз.",
            );
          if (error instanceof Error && error.name === "InvalidPDFException")
            throw new HttpError(
              400,
              "PDF ашылмады. Құжаттың басқа көшірмесін жүктеңіз.",
            );
          throw error;
        });
        try {
          if (pdf.numPages > 10)
            throw new HttpError(400, "PDF 10 беттен аспауы керек.");
        } finally {
          await pdf.loadingTask.destroy();
        }
      }
      const hash = createHash("sha256").update(req.file.buffer).digest("hex");
      const previous = await Document.find({ hash, kind })
        .sort({ createdAt: 1 })
        .lean();
      for (const doc of previous) {
        const conflict = await savedDocumentConflict(doc);
        if (conflict) throw new DuplicateError(conflict);
      }
      async function resumeUpload(doc: (typeof previous)[number]) {
        const draft = await resumeDraft(doc);
        if (
          draft.status !== "failed" ||
          draft.error !== originalFileMissing ||
          !draft.key ||
          draft.participantId
        )
          return draft;
        // This owner has just supplied the exact original bytes again.
        await storage.put(draft.key, req.file!.buffer, type!.mime);
        return (
          (await Document.findOneAndUpdate(
            {
              _id: draft._id,
              ownerId: req.session.adminId,
              hash,
              participantId: null,
              status: "failed",
              error: originalFileMissing,
            },
            {
              $set: {
                ...newReadCycle,
                recognitionVersion: readerVersion(kind),
              },
              $unset: { error: 1, completedAt: 1 },
            },
            { new: true },
          ).lean()) ||
          (await Document.findById(draft._id).lean()) ||
          draft
        );
      }
      const draft = previous.find(
        (doc) => String(doc.ownerId) === req.session.adminId,
      );
      if (draft) {
        res.json(uploadResult(await resumeUpload(draft), true));
        return;
      }
      const key = [
        process.env.S3_KEY_PREFIX?.replace(/^\/+|\/+$/g, ""),
        `${kind}/${randomBytes(24).toString("hex")}.${type.ext}`,
      ]
        .filter(Boolean)
        .join("/");
      await storage.put(key, req.file.buffer, type.mime);
      try {
        const doc = await Document.create({
          kind,
          key,
          mime: type.mime,
          size: req.file.size,
          hash,
          uploadHash: req.session.adminId + ":" + kind + ":" + hash,
          ownerId: req.session.adminId,
          originalName: req.file.originalname.slice(0, 200),
          status: "queued",
        });
        res.status(201).json(uploadResult(doc));
      } catch (e) {
        await storage.remove(key).catch(() => {});
        if ((e as any).code === 11000) {
          const original = await Document.findOne({
            hash,
            kind,
            ownerId: req.session.adminId,
          }).lean();
          if (original) {
            res.json(uploadResult(await resumeUpload(original), true));
            return;
          }
        }
        throw e;
      }
    },
  );
  app.get("/api/documents/:id", async (req, res) => {
    const d = await Document.findOne({
      _id: checkId(req.params.id),
      ownerId: req.session.adminId,
    })
      .select(documentStatusFields)
      .lean();
    if (!d) throw new HttpError(404, "Құжат табылмады.");
    res.json(await publicDocumentStatus(d));
  });
  app.post("/api/documents/:id/refresh", async (req, res) => {
    const owned = { _id: checkId(req.params.id), ownerId: req.session.adminId };
    const current = () =>
      Document.findOne(owned).select(documentStatusFields).lean();
    let doc = await current();
    if (!doc) throw new HttpError(404, "Құжат табылмады.");
    const version = readerVersion(doc.kind);
    if (needsReaderUpgrade(doc)) {
      // Claim the current reader version when queueing. Concurrent editors,
      // including after a failed scan, share this attempt.
      doc =
        (await Document.findOneAndUpdate(
          {
            ...owned,
            status: doc.status,
            recognitionVersion: doc.recognitionVersion ?? null,
          },
          {
            $set: {
              ...newReadCycle,
              recognitionVersion: version,
            },
            $unset: { error: 1, completedAt: 1 },
          },
          { new: true },
        )
          .select(documentStatusFields)
          .lean()) || (await current());
      if (!doc) throw new HttpError(404, "Құжат табылмады.");
    }
    res.json(await publicDocumentStatus(doc));
  });
  app.post("/api/documents/:id/retry", async (req, res) => {
    const owned = { _id: checkId(req.params.id), ownerId: req.session.adminId };
    const current = await Document.findOne(owned)
      .select(documentStatusFields)
      .lean();
    if (
      !current ||
      !["failed", "done"].includes(current.status ?? "") ||
      current.permanentReadFailure ||
      documentReadState(current).wrongDocumentKind
    )
      throw new HttpError(400, "Қайта оқу мүмкін емес.");
    const doc = await Document.findOneAndUpdate(
      { ...owned, status: current.status },
      {
        $set: {
          ...newReadCycle,
          recognitionVersion: readerVersion(current.kind),
        },
        $unset: { error: 1, completedAt: 1 },
      },
      { new: true },
    );
    if (!doc) throw new HttpError(400, "Қайта оқу мүмкін емес.");
    res.json({ ok: true });
  });
  app.get("/api/documents/:id/content", async (req, res) => {
    const d = await Document.findOne({
      _id: checkId(req.params.id),
      ownerId: req.session.adminId,
    });
    if (!d) throw new HttpError(404, "Құжат табылмады.");
    if (
      !d.mime ||
      !["application/pdf", "image/jpeg", "image/png"].includes(d.mime)
    )
      throw new HttpError(415, "Құжаттың бұл түрін көрсету мүмкін емес.");
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.on("close", disconnected);
    try {
      const object = await storage.open(d.key!, controller.signal);
      if (!(object.Body instanceof Readable))
        throw new Error("Document stream unavailable");
      res.type(d.mime);
      if (object.ContentLength !== undefined)
        res.set("Content-Length", String(object.ContentLength));
      // The browser requests this stream only when the document viewer opens.
      await pipeline(object.Body, res, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) throw error;
      if (!res.destroyed) res.destroy();
    } finally {
      res.off("close", disconnected);
    }
  });
  app.get("/api/documents/:id/url", async (req, res) => {
    const d = await Document.findOne({
      _id: checkId(req.params.id),
      ownerId: req.session.adminId,
    });
    if (!d) throw new HttpError(404, "Құжат табылмады.");
    res.json({ url: await storage.url(d.key!) });
  });
  app.get("/api/finance", async (req, res) => {
    const f = filtersSchema.parse(req.query);
    const match = {
      voidedAt: null,
      date: { $gte: `${f.year}-01-01`, $lt: `${f.year + 1}-01-01` },
    };
    const [items, total] = await Promise.all([
      Finance.find(match)
        .sort({ date: -1, _id: -1 })
        .skip((f.page - 1) * f.limit)
        .limit(f.limit)
        .lean(),
      Finance.countDocuments(match),
    ]);
    res.json({ items, total, page: f.page, limit: f.limit });
  });
  app.post("/api/finance", async (req, res) => {
    const data = financeSchema.parse(req.body);
    const result = await atomic(async (s) => {
      const [doc] = await Finance.create([data], { session: s });
      await audit(
        req.session.adminId!,
        "create",
        "FinancialTransaction",
        doc._id,
        null,
        doc.toObject(),
        s,
      );
      return doc;
    });
    res.status(201).json(result);
  });
  app.patch("/api/finance/:id", async (req, res) => {
    const data = financeSchema.parse(req.body),
      id = checkId(req.params.id);
    const result = await atomic(async (s) => {
      const before = await Finance.findOne({ _id: id, voidedAt: null }).session(
        s,
      );
      if (!before) throw new HttpError(404, "Жазба табылмады.");
      const after = await Finance.findByIdAndUpdate(
        id,
        { $set: data },
        { new: true, session: s },
      );
      await audit(
        req.session.adminId!,
        "update",
        "FinancialTransaction",
        id,
        before.toObject(),
        after?.toObject(),
        s,
      );
      return after;
    });
    res.json(result);
  });
  app.delete("/api/finance/:id", async (req, res) => {
    const id = checkId(req.params.id);
    await atomic(async (s) => {
      const before = await Finance.findOne({ _id: id, voidedAt: null }).session(
        s,
      );
      if (!before) throw new HttpError(404, "Жазба табылмады.");
      await Finance.updateOne(
        { _id: id },
        { $set: { voidedAt: new Date() } },
        { session: s },
      );
      await audit(
        req.session.adminId!,
        "void",
        "FinancialTransaction",
        id,
        before.toObject(),
        null,
        s,
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/statistics", async (req, res) =>
    res.json(await statistics(filtersSchema.parse(req.query))),
  );
  app.get("/api/reports/:type", async (req, res) => {
    const type = z.enum(reportTypes).parse(req.params.type),
      f = filtersSchema.parse(req.query);
    let category: { id: string; name: string } | undefined;
    if (type === "mangystau-district" && req.query.paymentCategoryId) {
      const id = checkId(z.string().parse(req.query.paymentCategoryId));
      const saved = await PaymentCategory.findById(id).select("name").lean();
      if (!saved) throw new HttpError(404, "Төлем түрі табылмады.");
      category = { id, name: saved.name };
    }
    const file = await makeReport(type, f, category);
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${type}-${f.year}.xlsx"; filename*=UTF-8''${encodeURIComponent(reportFilename(type, f.year))}`,
    });
    res.send(Buffer.from(file));
  });
  app.get("/api/settings", (_req, res) =>
    res.json({
      annualFee: 648700,
      timezone: "Asia/Almaty",
      storageConfigured: !!process.env.S3_ENDPOINT || !!process.env.S3_REGION,
      ocrLanguages: process.env.OCR_LANGUAGES || "kaz+rus+eng",
    }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ message: "Бет табылмады." }),
  );
  if (config.production && process.env.SERVE_FRONTEND === "true") {
    app.use(express.static(path.resolve("dist/web")));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.resolve("dist/web/index.html")),
    );
  }
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError)
        return res.status(400).json({
          message: "Мәліметтерді тексеріңіз.",
          fields: error.flatten().fieldErrors,
        });
      if (error.code === 11000)
        return res.status(409).json({
          message: error.keyPattern?.nameKey
            ? "Бұл төлем түрі тізімде бар. Оны тізімнен таңдаңыз."
            : error.keyPattern?.importKey || error.keyPattern?.iinKey
              ? "Бұл қатысушы бұрын енгізілген. Қайта қосуға болмайды."
              : "Бұл құжат немесе чек бұрын тіркелген. Қайта қосуға болмайды.",
        });
      if (error instanceof multer.MulterError)
        return res.status(400).json({
          message: _req.path.includes("/import/")
            ? "Excel файлы 10 МБ-тан аспауы керек."
            : "Файл 15 МБ-тан аспауы керек.",
        });
      if (
        error instanceof HttpError ||
        error instanceof ImportError ||
        error instanceof DuplicateError
      )
        return res.status(error.status).json({
          message: error.message,
          ...(error instanceof HttpError || error instanceof DuplicateError
            ? error.details
            : {}),
        });
      console.error("Request failed", {
        type: error.name,
        code: error.code,
        ...(process.env.NODE_ENV === "test" ? { stack: error.stack } : {}),
      });
      res.status(500).json({
        message: "Сақталмады. Қайта көріңіз. Қате қайталанса, көмек сұраңыз.",
      });
    },
  );
  return app;
}
