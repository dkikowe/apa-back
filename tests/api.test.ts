import { Readable } from "node:stream";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import request from "supertest";
import ExcelJS from "exceljs";
import type { Express } from "express";
let repl: MongoMemoryReplSet,
  app: Express,
  agent: ReturnType<typeof request.agent>,
  csrf: string,
  participantId: string,
  paymentId: string;
const person = {
  lastName: "Үлгіқызы",
  firstName: "Айгүл",
  middleName: "Сынақ",
  birthDate: "1990-05-10",
  region: "Ақтау",
  phone: "+7 000 000 0001",
};
const base = {
  year: 2026,
  amount: 109000,
  paymentDate: "2026-11-18",
  recipientName: "Сынақ ұйымы",
  receiptNumber: "TEST-001",
};
beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET =
    "integration-test-secret-with-at-least-32-characters";
  process.env.APP_ORIGIN = "http://localhost:5173";
  repl = await MongoMemoryReplSet.create({
    binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY || undefined },
    replSet: { count: 1 },
  });
  process.env.MONGODB_URI = repl.getUri("birlik_test");
  const models = await import("../server/models.js");
  await models.connect();
  await models.Admin.create({
    username: "test-admin",
    passwordHash: await bcrypt.hash("synthetic-test-password", 4),
  });
  app = (await import("../server/app.js")).createApp();
  agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ username: "test-admin", password: "synthetic-test-password" });
  expect(res.status).toBe(200);
  csrf = res.body.csrf;
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});
const post = (url: string, body: any) =>
  agent.post(url).set("x-csrf-token", csrf).send(body);
const patch = (url: string, body: any) =>
  agent.patch(url).set("x-csrf-token", csrf).send(body);
const detail = (year = 2026) =>
  agent.get(`/api/participants/${participantId}?year=${year}`);
describe("Real MongoDB API integration", { concurrent: false }, () => {
  it("blocks unauthenticated access, bad passwords and cross-origin writes", async () => {
    expect((await request(app).get("/api/participants")).status).toBe(401);
    expect((await agent.post("/api/participants").send(person)).status).toBe(
      403,
    );
    expect(
      (
        await post("/api/participants", person).set(
          "Origin",
          "https://attacker.invalid",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ username: "test-admin", password: "incorrect" })
      ).status,
    ).toBe(401);
  });
  it("creates a participant; no payment gives full remaining amount", async () => {
    const r = await post("/api/participants", person);
    expect(r.status).toBe(201);
    participantId = r.body._id;
    expect((await detail()).body).toMatchObject({
      status: "unpaid",
      remaining: 648700,
      age: 36,
    });
  });
  it("edits participant data and finds by name or normalized phone", async () => {
    expect(
      (
        await patch(`/api/participants/${participantId}`, {
          ...person,
          firstName: "Меруерт",
        })
      ).status,
    ).toBe(200);
    const r = await agent.get("/api/participants?q=Меру&year=2026");
    expect(r.body.total).toBe(1);
    expect(
      (await agent.get("/api/participants?q=7000000&year=2026")).body.total,
    ).toBe(1);
  });
  it("records 1090 tenge and leaves 5397", async () => {
    const r = await post(`/api/participants/${participantId}/payments`, base);
    expect(r.status).toBe(201);
    paymentId = r.body._id;
    expect((await detail()).body).toMatchObject({
      totalPaid: 109000,
      remaining: 539700,
      status: "partial",
    });
  });
  it("blocks duplicate receipts even with the former confirmation flag", async () => {
    expect(
      (await post(`/api/participants/${participantId}/payments`, base)).status,
    ).toBe(409);
    const r = await post(`/api/participants/${participantId}/payments`, {
      ...base,
      confirmDuplicate: true,
    });
    expect(r.status).toBe(409);
  });
  it("second payment completes annual fee and next year stays separate", async () => {
    expect(
      (
        await post(`/api/participants/${participantId}/payments`, {
          ...base,
          amount: 539700,
          receiptNumber: "TEST-002",
        })
      ).status,
    ).toBe(201);
    expect((await detail()).body).toMatchObject({
      totalPaid: 648700,
      remaining: 0,
      status: "paid",
    });
    expect((await detail(2027)).body).toMatchObject({
      totalPaid: 0,
      remaining: 648700,
      status: "unpaid",
    });
  });
  it("records 7000 tenge separately and shows 513 overpayment", async () => {
    await post(`/api/participants/${participantId}/payments`, {
      ...base,
      year: 2027,
      amount: 700000,
      receiptNumber: "TEST-003",
    });
    expect((await detail(2027)).body).toMatchObject({
      status: "paid",
      overpayment: 51300,
      remaining: 0,
    });
  });
  it("recalculates after editing and voiding a payment", async () => {
    expect(
      (await patch(`/api/payments/${paymentId}`, { ...base, amount: 50000 }))
        .status,
    ).toBe(200);
    expect((await detail()).body.remaining).toBe(59000);
    await post(`/api/payments/${paymentId}/void`, {});
    expect((await detail()).body.remaining).toBe(109000);
  });
  it("combines year, region, age and payment filters", async () => {
    await post("/api/participants", {
      ...person,
      firstName: "Бекзат",
      birthDate: "1950-01-01",
      region: "Жаңаөзен",
    });
    const r = await agent.get(
      "/api/participants?year=2026&region=" +
        encodeURIComponent("Ақтау") +
        "&age=1&status=partial",
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items[0]._id).toBe(participantId);
    expect(
      (await agent.get("/api/participants?year=2027&age=1&status=partial")).body
        .total,
    ).toBe(0);
  });
  it("exports every filtered member, not just one page", async () => {
    const response = await agent
      .get(
        "/api/reports/members?year=2026&region=" +
          encodeURIComponent("Ақтау") +
          "&age=1&status=partial&limit=1",
      )
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body);
    expect(book.worksheets[0].rowCount).toBe(4);
    expect(book.worksheets[0].getCell("B4").value).toBe("Меруерт");
  });
  it("records expenses without duplicating membership income", async () => {
    let r = await agent.get("/api/statistics?year=2026");
    const before = r.body.finance.balance;
    const f = await post("/api/finance", {
      type: "expense",
      amount: 100000,
      date: "2026-11-18",
      category: "Сынақ шығыс",
      description: "Синтетикалық жазба",
    });
    expect(f.status).toBe(201);
    r = await agent.get("/api/statistics?year=2026");
    expect(r.body.finance.balance).toBe(before - 100000);
    expect(r.body.finance.membership).toBe(1239700); // 5397 + 7000 received in 2026, regardless of contribution year.
    expect(
      (
        await patch(`/api/finance/${f.body._id}`, {
          type: "expense",
          amount: 50000,
          date: "2026-11-18",
          category: "Түзетілген шығыс",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await agent
          .delete(`/api/finance/${f.body._id}`)
          .set("x-csrf-token", csrf)
      ).status,
    ).toBe(200);
    expect(
      (await agent.get("/api/statistics?year=2026")).body.finance.balance,
    ).toBe(before);
  });
  it("archives/restores without deleting payment history", async () => {
    await post(`/api/participants/${participantId}/archive`, {});
    expect(
      (await agent.get("/api/participants?year=2026&age=1")).body.total,
    ).toBe(0);
    expect((await detail()).body.payments.length).toBeGreaterThan(0);
    expect(
      (
        await post(`/api/participants/${participantId}/payments`, {
          ...base,
          receiptNumber: "archived",
        })
      ).status,
    ).toBe(400);
    await post(`/api/participants/${participantId}/archive`, { restore: true });
    expect(
      (await agent.get("/api/participants?year=2026&age=1")).body.total,
    ).toBe(1);
  });
  it("supports manual correction after OCR failure and protects document ownership", async () => {
    const { Document, Admin } = await import("../server/models.js");
    const admin = await Admin.findOne();
    const doc = await Document.create({
      kind: "identity",
      ownerId: admin!._id,
      status: "failed",
      error: "Құжат оқылмады. Мәліметтерді қолмен толтыра аласыз.",
      key: "synthetic/key",
      hash: "synthetic",
    });
    const state = await agent.get(`/api/documents/${doc._id}`);
    expect(state.body).toMatchObject({
      status: "failed",
      error: "Құжат оқылмады.",
    });
    const refreshed = await post(`/api/documents/${doc._id}/refresh`, {});
    expect(refreshed.body).toMatchObject({
      status: "queued",
      recoveryHasCheckpoint: false,
    });
    // Simulate an older terminal worker failure for the manual-correction path below.
    await Document.updateOne(
      { _id: doc._id },
      { $set: { status: "failed", error: doc.error } },
    );
    const { uploadResult } = await import("../server/services/duplicates.js");
    expect(uploadResult(doc, true).error).toBe("Құжат оқылмады.");
    const created = await post("/api/participants", {
      ...person,
      firstName: "Қолмен түзетілген",
      iin: "000123456780",
      identityDocumentId: String(doc._id),
    });
    expect(created.status).toBe(201);
    expect(created.body.firstName).toBe("Қолмен түзетілген");
    expect(
      (
        await post("/api/participants", {
          ...person,
          identityDocumentId: String(doc._id),
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).get(`/api/documents/${doc._id}/url`)).status,
    ).toBe(401);
  });
  it("rejects a wrong-kind file even with a typed identifier and preserves saved attachments when replacement reading fails", async () => {
    const { Admin, Document, Participant, Payment } =
      await import("../server/models.js");
    const { receiptInsteadOfIdentity } =
      await import("../server/services/ocr-policy.js");
    const admin = await Admin.findOne({ username: "test-admin" });
    const ownerId = admin!._id;
    const [
      originalId,
      wrongKind,
      unreadableId,
      originalReceipt,
      unreadableReceipt,
    ] = await Document.create([
      { kind: "identity", ownerId, status: "done" },
      {
        kind: "identity",
        ownerId,
        status: "failed",
        error: receiptInsteadOfIdentity,
      },
      { kind: "identity", ownerId, status: "failed" },
      { kind: "receipt", ownerId, status: "done" },
      { kind: "receipt", ownerId, status: "failed" },
    ]);
    const identifier = "000000000839";
    for (const path of ["", "/refresh"]) {
      const url = "/api/documents/" + wrongKind._id + path;
      const r = path ? await post(url, {}) : await agent.get(url);
      expect(r.body.wrongDocumentKind).toBe(true);
    }
    const personWith = (documentId: unknown) => ({
      ...person,
      iin: identifier,
      identityDocumentId: String(documentId),
    });
    expect(
      (await post("/api/participants", personWith(wrongKind._id))).status,
    ).toBe(400);
    expect(await Participant.countDocuments({ iin: identifier })).toBe(0);
    const p = await post("/api/participants", personWith(originalId._id));
    expect(p.status).toBe(201);
    const url = "/api/participants/" + p.body._id;
    expect(
      (await patch(url, { identityDocumentId: String(unreadableId._id) }))
        .status,
    ).toBe(400);
    const payload = {
      ...base,
      receiptNumber: "REPLACEMENT-TEST-839",
      receiptDocumentId: String(originalReceipt._id),
    };
    const pay = await post(url + "/payments", payload);
    expect(pay.status).toBe(201);
    expect(
      (
        await patch("/api/payments/" + pay.body._id, {
          ...payload,
          receiptDocumentId: String(unreadableReceipt._id),
        })
      ).status,
    ).toBe(400);
    expect(
      String((await Participant.findById(p.body._id))!.identityDocumentId),
    ).toBe(String(originalId._id));
    expect(
      String((await Payment.findById(pay.body._id))!.receiptDocumentId),
    ).toBe(String(originalReceipt._id));
    expect(
      await Document.countDocuments({
        _id: { $in: [wrongKind._id, unreadableId._id, unreadableReceipt._id] },
        participantId: { $ne: null },
      }),
    ).toBe(0);
    await Document.updateMany(
      { _id: { $in: [originalId._id, originalReceipt._id] } },
      {
        $set: {
          status: "queued",
          recoveryStage: 8,
          recoveryHasCheckpoint: true,
        },
      },
    );
    expect((await patch(url, { notes: "unchanged document" })).status).toBe(
      200,
    );
    expect((await patch(url, { iin: "000000000840" })).status).toBe(400);
    expect(
      (
        await patch("/api/payments/" + pay.body._id, {
          ...payload,
          notes: "unchanged receipt",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch("/api/payments/" + pay.body._id, {
          ...payload,
          receiptNumber: "CHANGED-WHILE-READING",
        })
      ).status,
    ).toBe(400);
    await Document.updateOne(
      { _id: originalId._id },
      { $set: { status: "failed" } },
    );
    expect((await patch(url, { notes: "test note" })).status).toBe(200);
    await Payment.deleteOne({ _id: pay.body._id });
    await Participant.deleteOne({ _id: p.body._id });
    await Document.deleteMany({
      _id: {
        $in: [
          originalId._id,
          wrongKind._id,
          unreadableId._id,
          originalReceipt._id,
          unreadableReceipt._id,
        ],
      },
    });
  });
  it("requires the same printed number for a file and pasted receipt used together", async () => {
    const { Admin, Document, Payment } = await import("../server/models.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const account = await post("/api/participants", {
      firstName: "File and text check",
    });
    const doc = await Document.create({
      kind: "receipt",
      ownerId: owner!._id,
      status: "done",
      fields: { receiptNumber: "QR28394700001" },
    });
    const url = "/api/participants/" + account.body._id + "/payments";
    const payload = {
      ...base,
      receiptNumber: "QR28394700001",
      receiptDocumentId: String(doc._id),
    };
    const text = (number: string) =>
      "Оплата совершена 1 090 ₸ Сынақ № чека " +
      number +
      " Дата и время по Астане 18.11.2026 16:00";
    expect(
      (await post(url, { ...payload, receiptText: text("QR28394700002") }))
        .status,
    ).toBe(400);
    expect(
      (await post(url, { ...payload, receiptText: "Оплата совершена 1 090 ₸" }))
        .status,
    ).toBe(400);
    expect(await Payment.countDocuments({ receiptDocumentId: doc._id })).toBe(
      0,
    );
    const same = await post(url, {
      ...payload,
      receiptText: text(payload.receiptNumber),
    });
    expect(same.status).toBe(201);
    expect(
      (
        await patch("/api/payments/" + same.body._id, {
          ...payload,
          receiptText: text("QR28394700002"),
        })
      ).status,
    ).toBe(400);
    expect((await Payment.findById(same.body._id))!.receiptText).toBe(
      text(payload.receiptNumber),
    );
    const { Participant } = await import("../server/models.js");
    await Payment.deleteOne({ _id: same.body._id });
    await Document.deleteOne({ _id: doc._id });
    await Participant.deleteOne({ _id: account.body._id });
  });
  it("rejects executable uploads and oversized / invalid dates", async () => {
    const upload = await agent
      .post("/api/documents")
      .set("x-csrf-token", csrf)
      .field("kind", "identity")
      .attach("file", Buffer.from("<script>attack</script>"), "fake.png");
    expect(upload.status).toBe(400);
    expect(
      (
        await post("/api/finance", {
          type: "expense",
          amount: 1.1,
          date: "2026-11-18",
          category: "test",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/api/participants", { ...person, birthDate: "2026-02-30" }))
        .status,
    ).toBe(400);
  });
  it("blocks concurrent duplicate payments with a database unique index", async () => {
    const body = { ...base, receiptNumber: "concurrency-test" };
    const results = await Promise.all([
      post(`/api/participants/${participantId}/payments`, body),
      post(`/api/participants/${participantId}/payments`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it("exports multiple matching rows across pagination and calculates ages before birthdays", async () => {
    const { ageAt, ageGroup } = await import("../shared/domain.js");
    for (let i = 0; i < 3; i++) {
      const created = await post("/api/participants", {
        ...person,
        lastName: "Экспортсынақ" + i,
        birthDate: "2001-12-31",
      });
      expect(created.status).toBe(201);
      const record = (
        await agent.get(`/api/participants/${created.body._id}?year=2026`)
      ).body;
      expect(record.age).toBe(ageAt("2001-12-31"));
      expect(record.ageGroup).toBe(ageGroup(ageAt("2001-12-31")));
    }
    const list = await agent.get(
      "/api/participants?q=" + encodeURIComponent("Экспортсынақ") + "&limit=1",
    );
    expect(list.body.total).toBe(3);
    expect(list.body.items).toHaveLength(1);
    const exported = await agent
      .get(
        "/api/reports/members?q=" +
          encodeURIComponent("Экспортсынақ") +
          "&limit=1",
      )
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body);
    expect(workbook.worksheets[0].rowCount).toBe(6);
  });
  it("removes stale receipt fingerprints when correcting a receipt number", async () => {
    const personRow = await post("/api/participants", {
      ...person,
      lastName: "ЧектүзетуСынақ",
    });
    const body = { ...base, receiptNumber: "CLEAR-RECEIPT-TEST" };
    const payment = await post(
      `/api/participants/${personRow.body._id}/payments`,
      body,
    );
    expect(payment.status).toBe(201);
    const edited = await patch(`/api/payments/${payment.body._id}`, {
      ...body,
      receiptNumber: "",
    });
    expect(edited.status).toBe(200);
    expect(edited.body.fingerprint).toBeUndefined();
    expect(
      (await post(`/api/participants/${personRow.body._id}/payments`, body))
        .status,
    ).toBe(201);
  });

  it("preserves an OCR backfill when a stale form saves and detects competing edits to the same field", async () => {
    const created = await post("/api/participants", { firstName: "Мысал" });
    expect(created.status).toBe(201);
    const url = `/api/participants/${created.body._id}`;
    const fields = { birthDate: "1974-06-14", issuedBy: "Сынақ органы" };
    expect((await patch(url, fields)).status).toBe(200);
    const stale = { birthDate: "", issuedBy: "", notes: "" };
    const merged = await patch(url, {
      ...stale,
      notes: "Түзету",
      previousValues: stale,
    });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ ...fields, notes: "Түзету" });
    const conflicting = await patch(url, {
      birthDate: "1970-01-01",
      previousValues: { birthDate: "" },
    });
    expect(conflicting.status).toBe(412);
    const cleared = await patch(url, {
      issuedBy: "",
      previousValues: { issuedBy: fields.issuedBy },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      issuedBy: "",
      birthDate: fields.birthDate,
    });
  });
  it("saves optional identity details and preserves document leading zeros", async () => {
    const identity = {
      iin: "000123456789",
      documentNumber: "001234567",
      sex: "Әйел",
      citizenship: "Қазақстан",
      birthplace: "Ақтау қаласы",
      issuedBy: "Сынақ органы",
      issueDate: "2020-01-02",
      expiryDate: "2030-01-02",
    };
    const created = await post("/api/participants", {
      ...person,
      lastName: "ҚұжатСынақ",
      ...identity,
    });
    expect(created.status).toBe(201);
    expect(
      (await agent.get(`/api/participants/${created.body._id}`)).body,
    ).toMatchObject(identity);
    const changed = await patch(`/api/participants/${created.body._id}`, {
      ...person,
      lastName: "ҚұжатСынақ",
      ...identity,
      issuedBy: "",
      birthplace: "Маңғыстау облысы",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.documentNumber).toBe("001234567");
    expect(changed.body.issuedBy).toBe("");
    expect(changed.body.birthplace).toBe("Маңғыстау облысы");
    expect(
      (
        await patch(`/api/participants/${created.body._id}`, {
          citizenship: 42,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/api/participants", {
          ...person,
          issueDate: "2030-01-01",
          expiryDate: "2020-01-01",
        })
      ).status,
    ).toBe(400);
  });
  it("loads optional fields from a confirmed identity draft while preserving explicit edits", async () => {
    const { Admin, Document } = await import("../server/models.js");
    const owner = await Admin.findOne({ username: "test-admin" }).orFail();
    const fields = {
      sex: "Әйел",
      citizenship: "Қазақстан",
      birthplace: "Астана қаласы",
    };
    for (const attachOnEdit of [false, true]) {
      const iin = attachOnEdit ? "000000001904" : "000000002904";
      const doc = await Document.create({
        kind: "identity",
        ownerId: owner._id,
        status: "done",
        fields: { iin, ...fields },
      });
      const preview = await agent.get("/api/documents/" + doc.id);
      expect(preview.body.fields).toMatchObject(fields);
      const input = {
        iin,
        identityDocumentId: doc.id,
        citizenship: "Түзетілген",
        birthplace: "",
      };
      const created = await post("/api/participants", {
        lastName: "Мысал",
        ...(attachOnEdit ? {} : input),
      });
      expect(created.status).toBe(201);
      const url = "/api/participants/" + created.body._id;
      if (attachOnEdit) expect((await patch(url, input)).status).toBe(200);
      const saved = (await agent.get(url)).body;
      expect(saved).toMatchObject({
        sex: fields.sex,
        citizenship: input.citizenship,
        birthplace: "",
      });
      expect((await patch(url, { sex: "" })).body.sex).toBe("");
      expect((await patch(url, { notes: "Үлгі" })).body.sex).toBe("");
    }
  });
  async function workbookBytes(
    rows: any[][],
    headers: string[],
    name = "Лист 1",
  ) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(name);
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await book.xlsx.writeBuffer());
  }
  const excelHeaders = [
    "Фамилия",
    "Имя",
    "Дата рождения",
    "Регион",
    "Телефон",
    "Номер удостоверения",
    "ИИН",
    "Кем выдан",
    "Дата выдачи",
    "Срок действия",
    "Оплачено",
    "Год взноса",
    "Дата платежа",
  ];
  const excelRow = [
    "ExcelСынақ",
    "Айша",
    new Date("1970-05-04T00:00:00Z"),
    "Ақтау",
    "+7 000 000 0101",
    12345678,
    1234567890,
    "Сынақ органы",
    "01.02.2020",
    "01.02.2030",
    1090,
    2026,
    "18.11.2026",
  ];
  const previewFile = (buffer: Buffer, options: unknown = {}) =>
    agent
      .post("/api/participants/import/preview")
      .set("x-csrf-token", csrf)
      .field("options", JSON.stringify(options))
      .attach("file", buffer, "members.xlsx");
  it("previews real XLSX without writing, commits people/payments atomically, and makes repeat clicks idempotent", async () => {
    const { Participant, Payment } = await import("../server/models.js");
    const before = await Participant.countDocuments();
    const preview = await previewFile(
      await workbookBytes([excelRow], excelHeaders),
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ready: 1, errorCount: 0 });
    expect(await Participant.countDocuments()).toBe(before);
    const url = `/api/participants/import/${preview.body.draftId}/commit`;
    const results = await Promise.all([post(url, {}), post(url, {})]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body).toMatchObject({ created: 1, payments: 1 });
    const person = await Participant.findOne({ lastName: "ExcelСынақ" }).lean();
    expect(person).toMatchObject({
      birthDate: "1970-05-04",
      documentNumber: "012345678",
      iin: "001234567890",
      issuedBy: "Сынақ органы",
      issueDate: "2020-02-01",
    });
    expect(await Participant.countDocuments()).toBe(before + 1);
    expect(await Payment.countDocuments({ participantId: person!._id })).toBe(
      1,
    );
    expect(
      (await agent.get(`/api/participants/${person!._id}?year=2026`)).body
        .remaining,
    ).toBe(539700);
  });
  it("skips existing and within-file duplicate identities without replacing their data", async () => {
    const row = [...excelRow];
    row[0] = "ЖаңаExcelСынақ";
    row[5] = "998765432";
    row[6] = "999123456789";
    const preview = await previewFile(
      await workbookBytes([excelRow, row, row], excelHeaders),
    );
    expect(preview.body).toMatchObject({
      total: 3,
      ready: 1,
      duplicates: 2,
      errorCount: 0,
    });
    expect(
      (
        await post(
          `/api/participants/import/${preview.body.draftId}/commit`,
          {},
        )
      ).body.created,
    ).toBe(1);
  });
  it("reports row errors and requires an explicit date for imported payments", async () => {
    const bad = [...excelRow];
    bad[4] = "bad-phone";
    bad[12] = "";
    const preview = await previewFile(await workbookBytes([bad], excelHeaders));
    expect(preview.body).toMatchObject({ errorCount: 1 });
    expect(preview.body.draftId).toBeUndefined();
    expect(preview.body.issues[0].row).toBe(2);
    const noDate = [...excelRow];
    noDate[12] = "";
    const dates = await previewFile(
      await workbookBytes([noDate], excelHeaders),
    );
    expect(dates.body.errorCount).toBe(1);
    expect(dates.body.draftId).toBeUndefined();
  });
  it("supports manual column mapping and rejects spreadsheet formulas instead of trusting cached values", async () => {
    const headers = ["A", "B", "C", "D", "E"];
    const row = [
      "БағанСынақ",
      "Айгүл",
      "15.04.1975",
      "Ақтау",
      "+7 000 000 0202",
    ];
    const bytes = await workbookBytes([row], headers);
    const automatic = await previewFile(bytes);
    expect(automatic.body.missing.length).toBeGreaterThan(0);
    const mapped = await previewFile(bytes, {
      mapping: { lastName: 1, firstName: 2, birthDate: 3, region: 4, phone: 5 },
    });
    expect(mapped.body).toMatchObject({ ready: 1, errorCount: 0 });
    const formula = [...row] as any[];
    formula[0] = { formula: '"Injected"', result: "Injected" };
    const unsafe = await previewFile(await workbookBytes([formula], headers), {
      mapping: { lastName: 1, firstName: 2, birthDate: 3, region: 4, phone: 5 },
    });
    expect(unsafe.body.errorCount).toBe(1);
    expect(unsafe.body.draftId).toBeUndefined();
  });
  it("guards Excel endpoints and returns a usable empty template", async () => {
    expect(
      (await request(app).get("/api/participants/import/template")).status,
    ).toBe(401);
    const bytes = await workbookBytes([excelRow], excelHeaders);
    expect(
      (
        await agent
          .post("/api/participants/import/preview")
          .attach("file", bytes, "test.xlsx")
      ).status,
    ).toBe(403);
    expect((await previewFile(Buffer.from("not a spreadsheet"))).status).toBe(
      400,
    );
    const template = await agent
      .get("/api/participants/import/template")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(template.body);
    expect(book.worksheets[0].rowCount).toBe(1);
    expect(book.worksheets[0].getRow(1).values).toContain("Куәлік нөмірі");
  });

  it("detects a title row and a second worksheet, and accepts an explicit shared payment date", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Нұсқаулық").addRow(["Fill the second worksheet"]);
    const sheet = book.addWorksheet("Қатысушылар");
    sheet.addRow(["Сынақ тізім"]);
    sheet.addRow(excelHeaders);
    const row = [...excelRow];
    row[0] = "ПарақСынақ";
    row[5] = "123123123";
    row[6] = "123123123123";
    row[12] = "";
    sheet.addRow(row);
    const preview = await previewFile(
      Buffer.from(await book.xlsx.writeBuffer()),
      { sheet: sheet.id, paymentDate: "2026-11-20" },
    );
    expect(preview.body).toMatchObject({
      sheet: sheet.id,
      headerRow: 2,
      ready: 1,
      errorCount: 0,
    });
  });
  it("rejects another admin's preview and expired drafts", async () => {
    const { ImportDraft } = await import("../server/models.js");
    const otherDraft = await ImportDraft.create({
      adminId: new mongoose.Types.ObjectId(),
      rows: [],
      expiresAt: new Date(Date.now() + 60000),
    });
    expect(
      (await post(`/api/participants/import/${otherDraft._id}/commit`, {}))
        .status,
    ).toBe(400);
    const draft = await previewFile(
      await workbookBytes(
        [["МерзімСынақ", "Айша", "1975-01-01", "Ақтау", "+7 000 000 0303"]],
        excelHeaders.slice(0, 5),
      ),
    );
    expect(draft.body.ready).toBe(1);
    await ImportDraft.updateOne(
      { _id: draft.body.draftId },
      { $set: { expiresAt: new Date(0) } },
    );
    expect(
      (await post(`/api/participants/import/${draft.body.draftId}/commit`, {}))
        .status,
    ).toBe(400);
  });
  it("imports the Aktau-style layout with missing fields and preserves source annotations", async () => {
    const { Admin, Participant } = await import("../server/models.js");
    const { previewImport, commitImport } =
      await import("../server/services/imports.js");
    const { missingParticipantFields } = await import("../shared/domain.js");
    const { statistics } = await import("../server/services/reports.js");
    const { filtersSchema } = await import("../server/services/members.js");
    const admin = String((await Admin.findOne())!._id);
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Тізім");
    sheet.addRow(["ҚАТЫСУШЫЛАР ТІЗІМІ"]);
    sheet.addRow([
      "№",
      "АӘТ",
      "Жеке куәлік номері",
      "Жеке куәліктің жарамдылық мерзімі",
      "Ағылшын аты жөні",
      "Телефон",
      "Мекен жай",
    ]);
    sheet.addRow([
      1,
      "ТолықЕмесСынақ Айша",
      "ЖЕКЕ КУӘЛІК БЕРУДЕН БАС ТАРТТЫ",
      "",
      "",
      "+7 000 000 0301 ватцапта жоқ",
      "Ақтау?",
    ]);
    sheet.addRow([2, "АттасСынақ Айша"]);
    sheet.addRow([3, "АттасСынақ Айша"]);
    sheet.addRow([
      4,
      "МерзімСынақ Апа",
      "TEST0302",
      "01.02.2020-01.02.2030",
      "MERZIMSYNAQ APA",
      "",
      "Ақтау",
    ]);
    // Formatting and blank rows must not become unnamed participants.
    sheet.getRow(30).height = 25;
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const preview = await previewImport(bytes, {}, admin);
    expect(preview).toMatchObject({
      headerRow: 2,
      total: 4,
      ready: 4,
      incomplete: 4,
      errorCount: 0,
      missing: [],
    });
    expect(preview.examples[0]).toMatchObject({
      birthDate: "",
      region: "",
      phone: "+7 000 000 0301",
      documentNumber: "",
    });
    expect(preview.examples[0].notes).toContain("Ақтау?");
    expect(preview.examples[0].notes).toContain("БАС ТАРТТЫ");
    expect(await commitImport(preview.draftId!, admin)).toMatchObject({
      created: 4,
      payments: 0,
    });
    expect(await Participant.countDocuments({ lastName: "АттасСынақ" })).toBe(
      2,
    );
    const person = (await Participant.findOne({
      lastName: "ТолықЕмесСынақ",
    }).lean())!;
    const result = await agent.get(`/api/participants/${person._id}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      age: null,
      ageGroup: null,
      birthDate: "",
      region: "",
      status: "unpaid",
    });
    const young = await agent.get("/api/participants?q=ТолықЕмесСынақ&age=0");
    expect(young.body.total).toBe(0);
    const stats = await statistics(
      filtersSchema.parse({ q: "ТолықЕмесСынақ" }),
    );
    expect(stats.ages).toEqual([{ _id: null, count: 1 }]);
    const period = (await Participant.findOne({
      lastName: "МерзімСынақ",
    }).lean())!;
    expect(period).toMatchObject({
      issueDate: "2020-02-01",
      expiryDate: "2030-02-01",
      lastNameLatin: "MERZIMSYNAQ",
      firstNameLatin: "APA",
      birthDate: "",
    });
    const changed = {
      ...result.body,
      birthDate: "1970-01-01",
      region: "Ақтау",
      iin: "000000000301",
      documentNumber: "TEST0301",
      issuedBy: "Сынақ органы",
      issueDate: "2020-01-01",
      expiryDate: "2030-01-01",
    };
    expect(
      (await patch(`/api/participants/${person._id}`, changed)).status,
    ).toBe(200);
    const updated = await agent.get(`/api/participants/${person._id}`);
    expect(missingParticipantFields(updated.body)).toEqual([]);
    expect(updated.body.notes).toContain("Ақтау?");
    // Editing a participant must retain the source key so repeat import is safe.
    const repeated = await previewImport(bytes, {}, admin);
    expect(repeated).toMatchObject({ ready: 0, duplicates: 4, errorCount: 0 });
  });
  it("allows a partial participant through the regular API but rejects an entirely empty card", async () => {
    const added = await post("/api/participants", {
      firstName: "ЖартылайСынақ",
    });
    expect(added.status).toBe(201);
    const found = await agent.get(`/api/participants/${added.body._id}`);
    expect(found.body).toMatchObject({
      firstName: "ЖартылайСынақ",
      lastName: "",
      birthDate: "",
      phone: "",
      region: "",
      age: null,
      ageGroup: null,
    });
    expect(
      (
        await patch(`/api/participants/${added.body._id}`, {
          ...found.body,
          firstName: "ӨзгертілгенСынақ",
        })
      ).status,
    ).toBe(200);
    expect((await post("/api/participants", {})).status).toBe(400);
  });
  it("persists village and sorts payment history by actual date/time, including export", async () => {
    const added = await post("/api/participants", {
      firstName: "УақытСынақ",
      region: "Мұнайлы ауданы",
      village: "Басқұдық",
    });
    expect(added.status).toBe(201);
    const id = added.body._id;
    for (const [day, time] of [
      ["2026-10-16", "15:08"],
      ["2026-10-16", "09:30"],
      ["2026-10-15", "23:59:59"],
      ["2026-10-16", ""],
      ["2026-10-16", "15:08:03"],
    ]) {
      expect(
        (
          await post(`/api/participants/${id}/payments`, {
            year: 2026,
            amount: 100,
            paymentDate: day,
            paymentTime: time,
          })
        ).status,
      ).toBe(201);
    }
    const found = await agent.get(`/api/participants/${id}?year=2026`);
    expect(found.body.village).toBe("Басқұдық");
    expect(
      found.body.payments.map((p: any) => [p.paymentDate, p.paymentTime]),
    ).toEqual([
      ["2026-10-16", "15:08:03"],
      ["2026-10-16", "15:08"],
      ["2026-10-16", "09:30"],
      ["2026-10-16", ""],
      ["2026-10-15", "23:59:59"],
    ]);
    expect(
      (
        await post(`/api/participants/${id}/payments`, {
          year: 2026,
          amount: 100,
          paymentDate: "2026-10-16",
          paymentTime: "24:01",
        })
      ).status,
    ).toBe(400);
    const { makeReport } = await import("../server/services/reports.js");
    const { filtersSchema } = await import("../server/services/members.js");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      (await makeReport(
        "payments",
        filtersSchema.parse({ year: 2026, q: "УақытСынақ" }),
      )) as any,
    );
    const sheet = book.getWorksheet("Төлемдер")!;
    expect(sheet.getRow(3).values).toContain("Чек күні мен уақыты (Астана)");
    expect(
      [4, 5, 6, 7, 8].map((row) =>
        (sheet.getCell(row, 2).value as Date).toISOString(),
      ),
    ).toEqual([
      "2026-10-16T15:08:03.000Z",
      "2026-10-16T15:08:00.000Z",
      "2026-10-16T09:30:00.000Z",
      "2026-10-16T00:00:00.000Z",
      "2026-10-15T23:59:59.000Z",
    ]);
    expect(sheet.getCell("B7").numFmt).toBe("dd.mm.yyyy");
    expect(sheet.getCell("B5").numFmt).toBe("dd.mm.yyyy hh:mm");
    expect(sheet.getCell("B4").numFmt).toBe("dd.mm.yyyy hh:mm:ss");
  });
  it("hides marked profiles without removing their identity, receipts or income", async () => {
    const { Admin, Document, Participant, Payment } =
      await import("../server/models.js");
    const privateName = "VisibilityHidden";
    const input = { ...person, lastName: privateName, iin: "980101400147" };
    const created = (await post("/api/participants", input).expect(201)).body;
    const path = "/api/participants/" + created._id;
    const paid = {
      ...base,
      receiptNumber: "HIDDEN-427",
      year: 2082,
      paymentDate: "2082-03-04",
    };
    const payment = (await post(path + "/payments", paid).expect(201)).body;
    const before = (await agent.get("/api/statistics?year=2082")).body;
    const admin = await Admin.findOne({ username: "test-admin" }).orFail();
    const stale = await Document.create({
      ownerId: admin._id,
      kind: "identity",
      status: "duplicate",
      fields: { iin: input.iin },
      duplicate: { participantId: created._id, message: privateName },
    });
    await Participant.updateOne(
      { _id: created._id },
      { $set: { siteHiddenAt: new Date() } },
    );

    for (const archived of [false, true]) {
      const list = await agent
        .get("/api/participants")
        .query({ q: privateName, archived })
        .expect(200);
      expect(list.body).toMatchObject({ items: [], total: 0 });
    }
    await agent.get(path).expect(404);
    await patch(path, { notes: "stale" }).expect(404);
    await post(path + "/archive", { restore: true }).expect(404);
    await agent.delete(path).set("x-csrf-token", csrf).expect(404);
    await post(path + "/payments", base).expect(404);
    await patch("/api/payments/" + payment._id, paid).expect(404);
    await post("/api/payments/" + payment._id + "/void", {}).expect(404);
    const after = (await agent.get("/api/statistics?year=2082")).body;
    expect(after.totals.count).toBe(before.totals.count - 1);
    expect(after.finance).toEqual(before.finance);
    expect(await Participant.findById(created._id).lean()).toMatchObject(input);
    expect(await Payment.findById(payment._id).lean()).toMatchObject({
      amount: paid.amount,
      receiptNumber: paid.receiptNumber,
      voidedAt: null,
    });

    const fresh = (
      await post("/api/participants", { lastName: "VisibilityNew" }).expect(201)
    ).body;
    await agent.get("/api/participants/" + fresh._id).expect(200);
    const repeatedIin = (await post("/api/participants", input).expect(409))
      .body;
    const repeatedReceipt = (
      await post("/api/participants/" + fresh._id + "/payments", paid).expect(
        409,
      )
    ).body;
    const cached = (await agent.get("/api/documents/" + stale._id).expect(200))
      .body;
    for (const duplicate of [repeatedIin, repeatedReceipt, cached.duplicate]) {
      expect(duplicate.participantId).toBeUndefined();
      expect(duplicate.message).toBeTruthy();
      expect(duplicate.message).not.toContain(privateName);
    }
    expect(cached.error).not.toContain(privateName);
    const preview = await previewFile(
      await workbookBytes([["NewImportName", input.iin]], ["Фамилия", "ИИН"]),
    ).expect(200);
    expect(preview.body).toMatchObject({ duplicates: 1, ready: 0 });
    expect(JSON.stringify(preview.body)).not.toContain(privateName);
    await Participant.updateOne(
      { _id: created._id },
      { $unset: { siteHiddenAt: 1 } },
    );
    const restored = await agent.get(path).expect(200);
    expect(restored.body.payments.map((p: any) => p._id)).toEqual([
      payment._id,
    ]);
  });
  it("recognizes pasted receipts without writes, saves the source and detects duplicates", async () => {
    const { Payment, Document } = await import("../server/models.js");
    const before = [
      await Payment.countDocuments(),
      await Document.countDocuments(),
    ];
    const text =
      "➕ Сынақ 1956 +7 000 000 0001 — Оплата совершена 6 437 ₸ ОО Сынақ ұйымы № чека QR-PASTED-API ИИН/БИН продавца 000000000001 ФИО покупателя Үлгі А. Дата и время по Астане 01.08.2026 16:00 Оплачено с Kaspi Gold Адрес г. Астана";
    expect(
      (await request(app).post("/api/receipts/recognize-text").send({ text }))
        .status,
    ).toBe(403);
    expect(
      (await agent.post("/api/receipts/recognize-text").send({ text })).status,
    ).toBe(403);
    const read = await post("/api/receipts/recognize-text", { text });
    expect(read.status).toBe(200);
    expect(read.body.fields).toMatchObject({
      amount: 643700,
      paymentDate: "2026-08-01",
      paymentTime: "16:00",
      receiptNumber: "QR-PASTED-API",
      payerName: "Үлгі А.",
      recipientName: "ОО Сынақ ұйымы",
    });
    expect([
      await Payment.countDocuments(),
      await Document.countDocuments(),
    ]).toEqual(before);
    expect(
      (await post("/api/receipts/recognize-text", { text: "" })).status,
    ).toBe(400);
    expect(
      (await post("/api/receipts/recognize-text", { text: "a".repeat(20001) }))
        .status,
    ).toBe(400);
    expect(
      (await post("/api/receipts/recognize-text", { text: text + text }))
        .status,
    ).toBe(400);
    const person = await post("/api/participants", {
      firstName: "МәтінСынақ",
      region: "Ақтау",
      village: "Өмірзақ",
    });
    const input = { ...read.body.fields, year: 2026, receiptText: text };
    expect(
      (await post(`/api/participants/${person.body._id}/payments`, input))
        .status,
    ).toBe(201);
    const found = await agent.get(
      `/api/participants/${person.body._id}?year=2026`,
    );
    expect(found.body.village).toBe("Өмірзақ");
    const corrected = await patch(
      `/api/payments/${found.body.payments[0]._id}`,
      {
        ...input,
        payerName: "Үлгі Ә.",
      },
    );
    expect(corrected.status).toBe(200);
    expect(corrected.body.payerName).toBe("Үлгі Ә.");
    const { makeReport } = await import("../server/services/reports.js");
    const { filtersSchema } = await import("../server/services/members.js");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      (await makeReport(
        "payments",
        filtersSchema.parse({ year: 2026, q: "МәтінСынақ" }),
      )) as any,
    );
    expect(book.getWorksheet("Төлемдер")!.getRow(3).values).toContain(
      "Төлеген адам",
    );
    expect(book.getWorksheet("Төлемдер")!.getRow(4).values).toContain(
      "Үлгі Ә.",
    );

    expect(found.body.payments[0]).toMatchObject({
      receiptText: text,
      payerName: "Үлгі А.",
      paymentTime: "16:00",
    });
    expect(
      (await post(`/api/participants/${person.body._id}/payments`, input))
        .status,
    ).toBe(409);
  });
  it("posts a copied multiline Kaspi receipt once against its printed number", async () => {
    const source = [
      "Оплата 6 487 ₸",
      "ОО Сынақ бірлестігі",
      'шеберлер "URSHYK" (Ұршық)',
      "№ чека QR00000094721",
      "ИИН/БИН продавца 000000000001",
      "ФИО покупателя Үлгі А.",
      "Дата и время",
      "по Астане",
      "12.08.2026 10:00",
      "Оплачено с Kaspi Gold",
      "Адрес г. Астана",
    ].join("\\\n");
    const readUrl = "/api/receipts/recognize-text";
    const { body } = await post(readUrl, { text: source }).expect(200);
    const fields = {
      amount: 648700,
      receiptNumber: "QR00000094721",
      payerName: "Үлгі А.",
      recipientName: 'ОО Сынақ бірлестігі шеберлер "URSHYK" (Ұршық)',
      method: "с Kaspi Gold",
      receiptType: "urshyk",
      paymentDate: "2026-08-12",
      paymentTime: "10:00",
    };
    expect(body.fields).toMatchObject(fields);
    const member = await post("/api/participants", {
      firstName: "КөшірмеСынақ",
    }).expect(201);
    const payments = "/api/participants/" + member.body._id + "/payments";
    const payload = { ...body.fields, receiptText: source, year: 2026 };
    await post(payments, { ...payload, receiptNumber: "QR00000094722" }).expect(
      400,
    );
    const saved = await post(payments, payload).expect(201);
    await post(readUrl, { text: source }).expect(409);
    await post(payments, payload).expect(409);
    await patch("/api/payments/" + saved.body._id, {
      ...payload,
      receiptNumber: "QR00000094722",
    }).expect(400);
    const profile = await agent
      .get("/api/participants/" + member.body._id + "?year=2026")
      .expect(200);
    expect(profile.body.payments).toHaveLength(1);
    expect(profile.body.payments[0]).toMatchObject({
      ...fields,
      receiptText: source,
    });
    expect(profile.body.totalPaid).toBe(fields.amount);
  });
  it("loads document bytes only on request and enforces ownership without caching", async () => {
    const { Admin, Document } = await import("../server/models.js");
    const { storage } = await import("../server/services/storage.js");
    const owner = await Admin.findOne();
    const doc = await Document.create({
      kind: "receipt",
      ownerId: owner!._id,
      mime: "application/pdf",
      originalName: "Сынақ.pdf",
      key: "test/view",
      size: 12,
      status: "done",
    });
    const bytes = Buffer.from("%PDF-1.7\nsynthetic");
    const open = vi.spyOn(storage, "open").mockImplementation(
      async () =>
        ({
          Body: Readable.from([bytes]),
          ContentLength: bytes.length,
        }) as any,
    );
    try {
      const meta = await agent.get(`/api/documents/${doc._id}`);
      expect(meta.body).toMatchObject({
        mime: "application/pdf",
        originalName: "Сынақ.pdf",
      });
      expect(open).not.toHaveBeenCalled();
      const file = await agent
        .get(`/api/documents/${doc._id}/content`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
          res.on("error", cb);
        });
      expect(file.status).toBe(200);
      expect(file.body).toEqual(bytes);
      expect(file.headers["content-type"]).toContain("application/pdf");
      expect(file.headers["cache-control"]).toContain("no-store");
      expect(open).toHaveBeenCalledTimes(1);
      expect(
        (await request(app).get(`/api/documents/${doc._id}/content`)).status,
      ).toBe(401);
      await Document.updateOne(
        { _id: doc._id },
        { $set: { ownerId: new mongoose.Types.ObjectId() } },
      );
      expect(
        (await agent.get(`/api/documents/${doc._id}/content`)).status,
      ).toBe(404);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });
  it("sorts participants by their latest active payment before pagination and leaves unpaid participants last", async () => {
    const { Payment } = await import("../server/models.js");
    const ids: string[] = [];
    for (const firstName of ["А", "Б", "В", "Г"]) {
      const r = await post("/api/participants", {
        lastName: "УақытРетіСынақ",
        firstName,
        lastNameLatin: "ORDERTEST",
        firstNameLatin: "TEST",
      });
      expect(r.status).toBe(201);
      ids.push(r.body._id);
    }
    const entries = [
      {
        participantId: ids[0],
        year: 2026,
        amount: 100,
        paymentDate: "2026-10-02",
        paymentTime: "12:45",
      },
      {
        participantId: ids[1],
        year: 2026,
        amount: 100,
        paymentDate: "2026-10-02",
        paymentTime: "09:30",
      },
      {
        participantId: ids[1],
        year: 2026,
        amount: 100,
        paymentDate: "2026-10-01",
        paymentTime: "23:59",
      },
      {
        participantId: ids[2],
        year: 2026,
        amount: 100,
        paymentDate: "2026-10-01",
        paymentTime: "20:00",
      },
      {
        participantId: ids[2],
        year: 2026,
        amount: 100,
        paymentDate: "2026-12-31",
        paymentTime: "23:59",
        voidedAt: new Date(),
      },
      {
        participantId: ids[3],
        year: 2027,
        amount: 100,
        paymentDate: "2026-12-31",
        paymentTime: "23:59",
      },
    ];
    await Payment.insertMany(entries);
    for (const [direction, expected] of [
      ["desc", ids],
      ["asc", [ids[2], ids[1], ids[0], ids[3]]],
    ] as const) {
      for (let page = 1; page <= 4; page++) {
        const result = await agent.get("/api/participants").query({
          year: 2026,
          q: "УақытРетіСынақ",
          sort: "paymentTime",
          direction,
          page,
          limit: 1,
        });
        expect(result.status).toBe(200);
        expect(result.body.total).toBe(4);
        expect(result.body.items[0]._id).toBe(expected[page - 1]);
        expect(result.body.items[0].lastNameLatin).toBe("ORDERTEST");
      }
    }
  });
  it("uses the new inclusive age boundaries in list filters", async () => {
    const { today } = await import("../shared/domain.js");
    const year = Number(today().slice(0, 4));
    for (const [age, group] of [
      [25, 0],
      [26, 1],
      [45, 1],
      [46, 2],
      [65, 2],
      [66, 3],
    ]) {
      const r = await post("/api/participants", {
        lastName: "ЖасШекараСынақ",
        firstName: String(age),
        birthDate: `${year - age}-01-01`,
      });
      expect(r.status).toBe(201);
      const result = await agent
        .get("/api/participants")
        .query({ q: "ЖасШекараСынақ", age: String(group) });
      expect(
        result.body.items.some(
          (p: any) => p._id === r.body._id && p.ageGroup === group,
        ),
      ).toBe(true);
    }
  });
  it("stores receipt type and exposes the latest active recipient for the selected year", async () => {
    const p = await post("/api/participants", {
      lastName: "АлушыСынақ",
      firstName: "Үлгі",
    });
    const first = await post(`/api/participants/${p.body._id}/payments`, {
      ...base,
      receiptNumber: "RECIPIENT-OLD",
      paymentDate: "2026-01-01",
      recipientName: "Ескі алушы",
      receiptType: "personal",
      method: "Kaspi Gold",
    });
    expect(first.status).toBe(201);
    expect(first.body.receiptType).toBe("personal");
    const newer = await post(`/api/participants/${p.body._id}/payments`, {
      ...base,
      receiptNumber: "RECIPIENT-NEW",
      paymentDate: "2026-02-01",
      recipientName: "Жаңа алушы",
      receiptType: "urshyk",
    });
    expect(newer.status).toBe(201);
    const query = () =>
      agent.get("/api/participants").query({ q: "АлушыСынақ", year: 2026 });
    expect((await query()).body.items[0]).toMatchObject({
      lastRecipientName: "Жаңа алушы",
      lastReceiptType: "urshyk",
    });
    await post(`/api/payments/${newer.body._id}/void`, {});
    expect((await query()).body.items[0]).toMatchObject({
      lastRecipientName: "Ескі алушы",
      lastReceiptType: "personal",
    });
    expect(
      (
        await agent
          .get("/api/participants")
          .query({ q: "АлушыСынақ", year: 2027 })
      ).body.items[0].lastRecipientName,
    ).toBe("");
  });
  it("allows retrying incomplete recognition, but not concurrent or unauthorized jobs", async () => {
    const { Document, Admin } = await import("../server/models.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const doc = await Document.create({
      kind: "receipt",
      status: "done",
      ownerId: owner!._id,
      attempts: 1,
      fields: { amount: 100 },
    });
    expect((await post(`/api/documents/${doc._id}/retry`, {})).status).toBe(
      200,
    );
    expect((await post(`/api/documents/${doc._id}/retry`, {})).status).toBe(
      400,
    );
    await Document.updateOne(
      { _id: doc._id },
      { $set: { status: "done", attempts: 19 } },
    );
    expect((await post(`/api/documents/${doc._id}/retry`, {})).status).toBe(
      200,
    );
    for (const flags of [
      { permanentReadFailure: true },
      { wrongDocumentKind: true },
    ]) {
      await Document.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: "failed",
            permanentReadFailure: false,
            wrongDocumentKind: false,
            ...flags,
          },
        },
      );
      expect((await post(`/api/documents/${doc._id}/retry`, {})).status).toBe(
        400,
      );
    }
    await Document.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: "done",
          permanentReadFailure: false,
          wrongDocumentKind: false,
          attempts: 1,
          ownerId: new mongoose.Types.ObjectId(),
        },
      },
    );
    expect((await post(`/api/documents/${doc._id}/retry`, {})).status).toBe(
      400,
    );
  });
  it("blocks IIN duplicates including archived participants and concurrent requests", async () => {
    const iin = "000123456791";
    const results = await Promise.all(
      [1, 2].map(() => post("/api/participants", { ...person, iin })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const saved = results.find((r) => r.status === 201)!;
    expect(
      (
        await patch(`/api/participants/${saved.body._id}`, {
          ...person,
          iin,
          notes: "Edit original",
        })
      ).status,
    ).toBe(200);
    expect(
      (await patch(`/api/participants/${participantId}`, { ...person, iin }))
        .status,
    ).toBe(409);
    await post(`/api/participants/${saved.body._id}/archive`, {});
    const duplicate = await post("/api/participants", { ...person, iin });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.participantId).toBe(saved.body._id);
  });
  it("blocks receipt numbers regardless of case, spaces, amount, date, recipient or voiding", async () => {
    const p = await post("/api/participants", {
      ...person,
      firstName: "Қайталау",
    });
    const pay = await post(`/api/participants/${p.body._id}/payments`, {
      ...base,
      receiptNumber: "QR-DUP-410",
    });
    expect(pay.status).toBe(201);
    const repeat = {
      ...base,
      receiptNumber: " q r - d u p - 4 1 0 ",
      amount: 12300,
      year: 2027,
      paymentDate: "2027-01-01",
      recipientName: "Different",
      confirmDuplicate: true,
    };
    const duplicate = await post(
      `/api/participants/${participantId}/payments`,
      repeat,
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.paymentId).toBe(pay.body._id);
    expect(
      (
        await patch(`/api/payments/${pay.body._id}`, {
          ...base,
          receiptNumber: "QR-DUP-410",
          amount: 45600,
        })
      ).status,
    ).toBe(200);
    await post(`/api/payments/${pay.body._id}/void`, {});
    expect(
      (await post(`/api/participants/${participantId}/payments`, repeat))
        .status,
    ).toBe(409);
  });
  it("keeps one payment when two tabs submit the same number simultaneously", async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        post(`/api/participants/${participantId}/payments`, {
          ...base,
          receiptNumber: "QR-CONCURRENT-411",
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const { Payment } = await import("../server/models.js");
    expect(
      await Payment.countDocuments({ receiptNumberKey: "QR-CONCURRENT-411" }),
    ).toBe(1);
  });
  it("recognizes duplicate receipt numbers in pasted text", async () => {
    const number = "QR16813534981";
    const pay = await post(`/api/participants/${participantId}/payments`, {
      ...base,
      receiptNumber: number,
    });
    expect(pay.status).toBe(201);
    const text = `Оплата совершена 6 437 ₸ ОО Ремесленников URSHYK № чека ${number} Дата и время по Астане 01.08.2026 16:00 Оплачено с Kaspi Gold`;
    expect((await post("/api/receipts/recognize-text", { text })).status).toBe(
      409,
    );
    expect(
      (
        await post("/api/receipts/recognize-text", {
          text,
          paymentId: pay.body._id,
        })
      ).status,
    ).toBe(200);
  });
  it("requires an identifier for document-backed records but allows partial manual records", async () => {
    const { Document, Admin } = await import("../server/models.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const identity = await Document.create({
      kind: "identity",
      ownerId: owner!._id,
      status: "failed",
    });
    const receipt = await Document.create({
      kind: "receipt",
      ownerId: owner!._id,
      status: "failed",
    });
    expect(
      (
        await post("/api/participants", {
          ...person,
          identityDocumentId: String(identity._id),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/api/participants/${participantId}/payments`, {
          ...base,
          receiptNumber: "",
          receiptDocumentId: String(receipt._id),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/api/participants/${participantId}/payments`, {
          ...base,
          receiptNumber: "",
          receiptText: "unreadable receipt",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/api/participants", { firstName: "ТолықЕмес" })).status,
    ).toBe(201);
  });
  it("automatically reuses an unfinished upload without another storage write", async () => {
    const sharp = (await import("sharp")).default;
    const { storage } = await import("../server/services/storage.js");
    const put = vi.spyOn(storage, "put").mockResolvedValue();
    const remove = vi.spyOn(storage, "remove").mockResolvedValue();
    try {
      const bytes = await sharp({
        create: { width: 20, height: 20, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const upload = (name: string) =>
        agent
          .post("/api/documents")
          .set("x-csrf-token", csrf)
          .field("kind", "identity")
          .attach("file", bytes, name);
      const original = await upload("original.png");
      expect(original.status).toBe(201);
      const again = await upload("renamed.png");
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        id: original.body.id,
        status: "queued",
        reused: true,
      });
      expect(put).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
  });
  it("blocks different files with the same recognized IIN, while allowing reuse and rereading the original", async () => {
    const { Document, Admin } = await import("../server/models.js");
    const { completeRecognition } =
      await import("../server/services/duplicates.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const make = () =>
      Document.create({
        kind: "identity",
        ownerId: owner!._id,
        status: "processing",
      });
    const original = await make(),
      copy = await make();
    const fields = {
      iin: "000123456792",
      firstName: "Тексеру",
      lastName: "Сынақ",
    };
    await completeRecognition(original, fields);
    await completeRecognition(copy, fields);
    const checked = await Document.findById(copy._id).lean();
    expect(checked).toMatchObject({ status: "done", fields });
    const saved = await post("/api/participants", {
      ...person,
      iin: fields.iin,
      identityDocumentId: String(original._id),
    });
    expect(saved.status).toBe(201);
    expect(
      (
        await post("/api/participants", {
          ...person,
          iin: fields.iin,
          identityDocumentId: String(copy._id),
        })
      ).status,
    ).toBe(409);
    await completeRecognition(await Document.findById(original._id), fields);
    expect((await Document.findById(original._id))?.status).toBe("done");
    const another = await make();
    await completeRecognition(another, fields);
    expect((await Document.findById(another._id))?.duplicate).toMatchObject({
      participantId: saved.body._id,
    });
  });
  it("allows competing drafts but saves the receipt only once", async () => {
    const { Document, Admin } = await import("../server/models.js");
    const { completeRecognition } =
      await import("../server/services/duplicates.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const make = () =>
      Document.create({
        kind: "receipt",
        ownerId: owner!._id,
        status: "processing",
      });
    const a = await make(),
      b = await make();
    await Promise.all([
      completeRecognition(a, { receiptNumber: "QR-RACE-412" }),
      completeRecognition(b, { receiptNumber: "qr-race-412" }),
    ]);
    const docs = await Document.find({ _id: { $in: [a._id, b._id] } });
    expect(docs.map((d) => d.status)).toEqual(["done", "done"]);
    const attempts = await Promise.all(
      docs.map((doc) =>
        post(`/api/participants/${participantId}/payments`, {
          ...base,
          receiptNumber: "QR-RACE-412",
          receiptDocumentId: String(doc._id),
        }),
      ),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 409]);
    const saved = attempts.find((r) => r.status === 201)!;
    const c = await make();
    await completeRecognition(c, { receiptNumber: "QR-RACE-412" });
    expect((await Document.findById(c._id))?.duplicate).toMatchObject({
      paymentId: saved.body._id,
    });
  });
  it("blocks reuse of a legacy receipt attachment even if its hash is absent and number changed", async () => {
    const { Document, Admin } = await import("../server/models.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const doc = await Document.create({
      kind: "receipt",
      ownerId: owner!._id,
      status: "done",
    });
    const first = await post(`/api/participants/${participantId}/payments`, {
      ...base,
      receiptNumber: "LEGACY-DOC-1",
      receiptDocumentId: String(doc._id),
    });
    expect(first.status).toBe(201);
    const second = await post(`/api/participants/${participantId}/payments`, {
      ...base,
      receiptNumber: "LEGACY-DOC-2",
      receiptDocumentId: String(doc._id),
    });
    expect(second.status).toBe(409);
    expect(second.body.paymentId).toBe(first.body._id);
  });
  it("keeps one stored document and removes the losing blob for concurrent identical uploads", async () => {
    const sharp = (await import("sharp")).default;
    const { storage } = await import("../server/services/storage.js");
    const { Document } = await import("../server/models.js");
    let arrived = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = vi.spyOn(storage, "put").mockImplementation(async () => {
      if (++arrived === 2) release();
      await barrier;
    });
    const remove = vi.spyOn(storage, "remove").mockResolvedValue();
    try {
      const bytes = await sharp({
        create: { width: 21, height: 21, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer();
      const results = await Promise.all(
        [1, 2].map((i) =>
          agent
            .post("/api/documents")
            .set("x-csrf-token", csrf)
            .field("kind", "receipt")
            .attach("file", bytes, `race-${i}.png`),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      const original = results.find((r) => r.status === 201)!;
      expect(results.find((r) => r.status === 200)!.body).toMatchObject({
        id: original.body.id,
        reused: true,
      });
      const doc = await Document.findById(original.body.id);
      expect(
        await Document.countDocuments({ hash: doc!.hash, kind: "receipt" }),
      ).toBe(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalledWith(doc!.key);
    } finally {
      release();
      put.mockRestore();
      remove.mockRestore();
    }
  });
  it("creates a shared payment category without creating payments or changing balances", async () => {
    const { Payment } = await import("../server/models.js");
    const count = await Payment.countDocuments();
    const created = await post("/api/payment-categories", {
      name: "  Көрмеге   қатысу  ",
      amount: 500000,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Көрмеге қатысу",
      amount: 500000,
    });
    const catalog = await agent.get("/api/payment-categories");
    expect(catalog.status).toBe(200);
    expect(catalog.body.items).toContainEqual(
      expect.objectContaining({
        _id: created.body._id,
        name: "Көрмеге қатысу",
      }),
    );
    expect(await Payment.countDocuments()).toBe(count);
    expect(
      (
        await post("/api/payment-categories", {
          name: "көрмеге қатысу",
          amount: 600000,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("/api/payment-categories", {
          name: "Мүшелік жарна",
          amount: 600000,
        })
      ).status,
    ).toBe(409);
    expect(
      (await post("/api/payment-categories", { name: "", amount: 1 })).status,
    ).toBe(400);
    expect(
      (
        await post("/api/payment-categories", {
          name: "Invalid amount",
          amount: 0,
        })
      ).status,
    ).toBe(400);
    expect((await request(app).get("/api/payment-categories")).status).toBe(
      401,
    );
  });
  it("keeps additional payments out of membership debt and includes them once in income and exports", async () => {
    const { Payment } = await import("../server/models.js");
    const cat = (await agent.get("/api/payment-categories")).body.items[0];
    const p1 = (
      await post("/api/participants", { ...person, firstName: "ТөлемТүрі" })
    ).body;
    const p2 = (
      await post("/api/participants", { ...person, firstName: "ЕкіншіТүрі" })
    ).body;
    const extra = await post(`/api/participants/${p1._id}/payments`, {
      ...base,
      year: 2038,
      paymentDate: "2038-02-01",
      receiptNumber: "EXTRA-2038-1",
      paymentCategoryId: cat._id,
      amount: 200000,
      paymentKind: "membership",
      paymentCategoryName: "forged",
    });
    expect(extra.status).toBe(201);
    expect(extra.body).toMatchObject({
      paymentKind: "additional",
      paymentCategoryId: cat._id,
      paymentCategoryName: cat.name,
      amount: 200000,
    });
    const second = await post(`/api/participants/${p2._id}/payments`, {
      ...base,
      year: 2038,
      paymentDate: "2038-02-02",
      receiptNumber: "EXTRA-2038-2",
      paymentCategoryId: cat._id,
      amount: 500000,
    });
    expect(second.status).toBe(201);
    let profile = await agent.get(`/api/participants/${p1._id}?year=2038`);
    expect(profile.body).toMatchObject({
      totalPaid: 0,
      remaining: 648700,
      status: "unpaid",
      lastPaymentAt: "2038-02-01T",
    });
    expect(profile.body.payments[0].paymentCategoryName).toBe(cat.name);
    // A pre-existing row without new fields still counts as membership.
    await Payment.collection.insertOne({
      participantId: new mongoose.Types.ObjectId(p1._id),
      year: 2038,
      paymentDate: "2038-01-01",
      amount: 100000,
      voidedAt: null,
    });
    profile = await agent.get(`/api/participants/${p1._id}?year=2038`);
    expect(profile.body).toMatchObject({
      totalPaid: 100000,
      remaining: 548700,
      status: "partial",
    });
    const stats = (await agent.get("/api/statistics?year=2038")).body;
    expect(stats.finance).toMatchObject({
      membership: 100000,
      additional: 700000,
      totalIncome: 800000,
      balance: 800000,
    });
    expect(stats.finance.months[1]).toMatchObject({
      membership: 0,
      additional: 700000,
    });
    for (const type of ["payments", "income", "financial"]) {
      const exported = await agent
        .get(`/api/reports/${type}?year=2038`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (x) => chunks.push(x));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(exported.status).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(exported.body);
      const values = JSON.stringify(workbook.worksheets[0].getSheetValues());
      expect(values).toContain(
        type === "financial" ? "Қосымша төлемдер" : cat.name,
      );
    }
    expect(
      (
        await post(`/api/participants/${p1._id}/payments`, {
          ...base,
          paymentCategoryId: cat._id,
          receiptNumber: "EXTRA-2038-1",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(`/api/participants/${p1._id}/payments`, {
          ...base,
          paymentCategoryId: new mongoose.Types.ObjectId().toString(),
          receiptNumber: "UNKNOWN-CAT",
        })
      ).status,
    ).toBe(400);
    // Older clients editing another field must preserve the additional category.
    const edited = await patch(`/api/payments/${extra.body._id}`, {
      ...base,
      year: 2038,
      paymentDate: "2038-02-01",
      receiptNumber: "EXTRA-2038-1",
      amount: 250000,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.paymentKind).toBe("additional");
    const membership = await patch(`/api/payments/${extra.body._id}`, {
      ...base,
      year: 2038,
      paymentDate: "2038-02-01",
      receiptNumber: "EXTRA-2038-1",
      amount: 250000,
      paymentCategoryId: "",
    });
    expect(membership.status).toBe(200);
    expect(membership.body.paymentKind).toBe("membership");
    expect(membership.body.paymentCategoryId).toBeUndefined();
    expect(
      (await agent.get(`/api/participants/${p1._id}?year=2038`)).body.totalPaid,
    ).toBe(350000);
    await post(`/api/payments/${second.body._id}/void`, {});
    expect(
      (await agent.get("/api/statistics?year=2038")).body.finance,
    ).toMatchObject({ membership: 350000, additional: 0, totalIncome: 350000 });
  });
  it("upload, cancel, reupload for another participant succeeds; a saved receipt still blocks repeats", async () => {
    const sharp = (await import("sharp")).default;
    const { storage } = await import("../server/services/storage.js");
    const { Document, Payment } = await import("../server/models.js");
    const { completeRecognition } =
      await import("../server/services/duplicates.js");
    const put = vi.spyOn(storage, "put").mockResolvedValue();
    try {
      const wrong = (
        await post("/api/participants", { firstName: "ҚатеТаңдау" })
      ).body;
      const right = (
        await post("/api/participants", { firstName: "ДұрысТаңдау" })
      ).body;
      const bytes = await sharp({
        create: { width: 23, height: 23, channels: 3, background: "green" },
      })
        .png()
        .toBuffer();
      const upload = () =>
        agent
          .post("/api/documents")
          .set("x-csrf-token", csrf)
          .field("kind", "receipt")
          .attach("file", bytes, "cancelled.png");
      const first = await upload();
      expect(first.status).toBe(201);
      const fields = {
        receiptNumber: "CANCEL-THEN-SAVE",
        paymentTime: "08:15",
        payerName: "Сынақ А.",
        recipientName: "Сынақ Б.",
        method: "Аударым",
        amount: 120000,
        paymentDate: "2026-11-26",
      };
      await completeRecognition(await Document.findById(first.body.id), fields);
      // Closing/cancelling the form sends no payment and leaves a reusable draft.
      expect(await Payment.countDocuments({ participantId: wrong._id })).toBe(
        0,
      );
      const resumed = await upload();
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({
        id: first.body.id,
        status: "done",
        reused: true,
        fields,
      });
      const pay = await post(`/api/participants/${right._id}/payments`, {
        ...base,
        ...fields,
        receiptDocumentId: resumed.body.id,
      });
      expect(pay.status).toBe(201);
      expect(
        String((await Document.findById(first.body.id))!.participantId),
      ).toBe(right._id);
      expect(await Payment.countDocuments({ participantId: wrong._id })).toBe(
        0,
      );
      const blocked = await upload();
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({
        paymentId: pay.body._id,
        participantId: right._id,
      });
      expect(
        (
          await post(`/api/participants/${wrong._id}/payments`, {
            ...base,
            ...fields,
            receiptDocumentId: resumed.body.id,
          })
        ).status,
      ).toBe(400);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      put.mockRestore();
    }
  });
  it("resumes partial attached identities atomically, including checkpoints left by an interrupted deployment", async () => {
    const { Admin, Document, Participant } =
      await import("../server/models.js");
    const { IDENTITY_RECOGNITION_VERSION: version } =
      await import("../shared/document-recognition.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const doc = await Document.create({
      kind: "identity",
      ownerId: owner!._id,
      status: "done",
      attempts: 3,
      fields: { firstName: "Сынақ" },
    });
    const url = `/api/documents/${doc._id}/refresh`;
    expect((await post(url, {})).body.status).toBe("queued");
    const person = await Participant.create({
      firstName: "Сынақ",
      identityDocumentId: doc._id,
    });
    try {
      for (const r of await Promise.all([post(url, {}), post(url, {})])) {
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          status: "queued",
          recognitionVersion: version,
          attempts: 3,
          fields: { firstName: "Сынақ" },
        });
      }
      // A newer reader takes the next turn immediately when the user reopens
      // a previously deferred upload, even if its next daily retry is far away.
      await Document.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: "queued",
            recognitionVersion: version - 1,
            recoveryHasCheckpoint: true,
            recoveryStage: 22,
            nextReadAt: new Date(Date.now() + 86400000),
          },
        },
      );
      expect((await post(url, {})).body).toMatchObject({
        status: "queued",
        recognitionVersion: version,
        recoveryStage: 0,
        recoveryHasCheckpoint: false,
        nextReadAt: null,
      });
      await Document.updateOne(
        { _id: doc._id },
        { $set: { status: "failed", error: "read error" } },
      );
      expect((await post(url, {})).body.status).toBe("failed");
      await Document.updateOne({ _id: doc._id }, { $set: { status: "done" } });
      expect((await post(url, {})).body).toMatchObject({
        status: "queued",
        recoveryHasCheckpoint: false,
        recoveryStage: 0,
      });
      await Document.updateOne(
        { _id: doc._id },
        { $set: { ownerId: new mongoose.Types.ObjectId() } },
      );
      expect((await post(url, {})).status).toBe(404);
    } finally {
      await Participant.deleteOne({ _id: person._id });
      await Document.deleteOne({ _id: doc._id });
    }
  });
  it("refreshes an attached version-three receipt in payment edit without saving a payment or claiming its own number", async () => {
    const { Admin, Document, Participant, Payment } =
      await import("../server/models.js");
    const { completeRecognition, resumeDraft } =
      await import("../server/services/duplicates.js");
    const { RECEIPT_RECOGNITION_VERSION } =
      await import("../shared/document-recognition.js");
    const owner = await Admin.findOne({ username: "test-admin" });
    const fields = { receiptNumber: "SAVED-RECEIPT-REFRESH", amount: 648700 };
    const doc = await Document.create({
      kind: "receipt",
      ownerId: owner!._id,
      status: "done",
      recognitionVersion: 3,
      fields,
      attempts: 3,
    });
    const participant = await Participant.create({ firstName: "Сынақ" });
    const payment = await Payment.create({
      ...base,
      ...fields,
      participantId: participant._id,
      receiptDocumentId: doc._id,
      recipientName: "Сақталған алушы",
    });
    try {
      const url = `/api/documents/${doc._id}/refresh`;
      expect((await post(url, {})).body).toMatchObject({
        status: "queued",
        recognitionVersion: RECEIPT_RECOGNITION_VERSION,
      });
      await completeRecognition(doc, {
        ...fields,
        recipientName: "Оқылған алушы",
        payerName: "Сынақ Т.",
        paymentDate: "2026-10-15",
        paymentTime: "12:30",
        method: "Аударым",
      });
      const read = await post(url, {});
      expect(read.body).toMatchObject({
        status: "done",
        fields: { method: "Аударым" },
      });
      expect((await Payment.findById(payment._id))!.recipientName).toBe(
        "Сақталған алушы",
      );
      await expect(resumeDraft(doc)).rejects.toThrow();
    } finally {
      await Payment.deleteOne({ _id: payment._id });
      await Document.deleteOne({ _id: doc._id });
      await Participant.deleteOne({ _id: participant._id });
    }
  });
  it("automatically rereads an old incomplete identity draft once without reserving or duplicating it", async () => {
    const { Document } = await import("../server/models.js");
    const { resumeDraft, completeRecognition } =
      await import("../server/services/duplicates.js");
    const doc = await Document.create({
      kind: "identity",
      status: "done",
      fields: {
        lastName: "Сынақ",
        firstName: "Сынақ",
        firstNameLatin: "SAMPLE",
        lastNameLatin: "SAMPLE",
        iin: "000000000807",
        birthDate: "1975-04-15",
        documentNumber: "000123456",
        issuedBy: "01.02.2020 — 01.02.2030",
        issueDate: "2020-02-01",
        expiryDate: "2030-02-01",
      },
      recognitionVersion: 5,
      attempts: 3,
    });
    expect((await resumeDraft(doc)).status).toBe("queued");
    expect((await resumeDraft(await Document.findById(doc._id))).status).toBe(
      "queued",
    );
    await completeRecognition(doc, { lastName: "Сынақ" });
    const updated = await Document.findById(doc._id);
    expect(updated!.recognitionVersion).toBe(
      (await import("../shared/document-recognition.js"))
        .IDENTITY_RECOGNITION_VERSION,
    );
    expect((await resumeDraft(updated)).status).toBe("queued");
    expect(await Document.countDocuments({ _id: doc._id })).toBe(1);
  });
  it("recovers legacy drafts marked duplicate of another unsaved upload", async () => {
    const sharp = (await import("sharp")).default;
    const { createHash } = await import("node:crypto");
    const { Document, Admin } = await import("../server/models.js");
    const { storage } = await import("../server/services/storage.js");
    const put = vi.spyOn(storage, "put").mockResolvedValue();
    try {
      const owner = await Admin.findOne({ username: "test-admin" });
      const bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: "yellow" },
      })
        .png()
        .toBuffer();
      const fields = { receiptNumber: "UNSAVED-LEGACY-RECEIPT", amount: 50000 };
      await Document.create({
        kind: "receipt",
        ownerId: owner!._id,
        status: "done",
        fields,
        recognitionKey: "receipt:UNSAVED-LEGACY-RECEIPT",
      });
      const old = await Document.create({
        kind: "receipt",
        ownerId: owner!._id,
        hash: createHash("sha256").update(bytes).digest("hex"),
        status: "duplicate",
        fields,
        error: "old duplicate warning",
        duplicate: { canReuse: true },
      });
      const result = await agent
        .post("/api/documents")
        .set("x-csrf-token", csrf)
        .field("kind", "receipt")
        .attach("file", bytes, "old.png");
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        id: String(old._id),
        status: "queued",
        fields,
        reused: true,
      });
      const updated = await Document.findById(old._id).lean();
      expect(updated?.duplicate).toBeUndefined();
      expect(updated?.error).toBeUndefined();
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
  });
  it("restores missing draft storage from a matching re-upload and shares its new reading cycle", async () => {
    const sharp = (await import("sharp")).default;
    const { createHash } = await import("node:crypto");
    const { Document, Admin } = await import("../server/models.js");
    const { storage } = await import("../server/services/storage.js");
    const { originalFileMissing } =
      await import("../server/services/document-errors.js");
    const put = vi.spyOn(storage, "put").mockResolvedValue();
    const owner = await Admin.findOne({ username: "test-admin" });
    const bytes = await sharp({
      create: { width: 41, height: 29, channels: 3, background: "cyan" },
    })
      .png()
      .toBuffer();
    const hash = createHash("sha256").update(bytes).digest("hex");
    const key = "receipt/missing-test.png";
    const doc = await Document.create({
      kind: "receipt",
      key,
      hash,
      ownerId: owner!._id,
      status: "failed",
      permanentReadFailure: true,
      error: originalFileMissing,
    });
    try {
      const upload = () =>
        agent
          .post("/api/documents")
          .set("x-csrf-token", csrf)
          .field("kind", "receipt")
          .attach("file", bytes, "restored.png");
      expect((await upload()).body).toMatchObject({
        id: String(doc._id),
        reused: true,
        status: "queued",
        recoveryStage: 0,
        recoveryHasCheckpoint: false,
        permanentReadFailure: false,
      });
      expect(put).toHaveBeenCalledWith(key, bytes, "image/png");
      expect((await upload()).body.status).toBe("queued");
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      put.mockRestore();
      await Document.deleteOne({ _id: doc._id });
    }
  });
  it("does not expose another administrator's unfinished document when uploading identical bytes", async () => {
    const sharp = (await import("sharp")).default;
    const { createHash } = await import("node:crypto");
    const { Document, Admin } = await import("../server/models.js");
    const { storage } = await import("../server/services/storage.js");
    const put = vi.spyOn(storage, "put").mockResolvedValue();
    try {
      const bytes = await sharp({
        create: { width: 25, height: 25, channels: 3, background: "purple" },
      })
        .png()
        .toBuffer();
      const hash = createHash("sha256").update(bytes).digest("hex");
      const other = await Document.create({
        kind: "receipt",
        ownerId: new mongoose.Types.ObjectId(),
        hash,
        uploadHash: "receipt:" + hash,
        status: "queued",
      });
      const result = await agent
        .post("/api/documents")
        .set("x-csrf-token", csrf)
        .field("kind", "receipt")
        .attach("file", bytes, "own-copy.png");
      expect(result.status).toBe(201);
      expect(result.body.id).not.toBe(String(other._id));
      const owner = await Admin.findOne({ username: "test-admin" });
      expect(String((await Document.findById(result.body.id))!.ownerId)).toBe(
        String(owner!._id),
      );
      expect((await agent.get(`/api/documents/${other._id}`)).status).toBe(404);
    } finally {
      put.mockRestore();
    }
  });
  it.each([false, true])(
    "deletes a participant permanently while preserving the receipt and posted income (archived: %s)",
    async (archived) => {
      const { Admin, Audit, Document, Payment } =
        await import("../server/models.js");
      const admin = await Admin.findOne({ username: "test-admin" }).orFail();
      const marker = archived ? "ArchivedRemoval" : "ActiveRemoval";
      const iin = archived ? "000000001982" : "000000001981";
      const identity = await Document.create({
        ownerId: admin._id,
        kind: "identity",
        status: "done",
        fields: { iin },
      });
      const participant = {
        ...person,
        firstName: marker,
        iin,
        identityDocumentId: String(identity._id),
      };
      const paid = {
        ...base,
        year: 2081,
        paymentDate: "2081-01-15",
        receiptNumber: "REMOVE-" + marker,
      };
      const receipt = await Document.create({
        ownerId: admin._id,
        kind: "receipt",
        status: "done",
        fields: paid,
        key: marker + ".pdf",
        hash: "hash-" + marker,
        mime: "application/pdf",
      });
      const created = await post("/api/participants", participant);
      expect(created.status).toBe(201);
      const path = "/api/participants/" + created.body._id;
      const stats = () => agent.get("/api/statistics?year=2081");
      const priorIncome = (await stats()).body.finance.membership;
      const payment = await post(path + "/payments", {
        ...paid,
        receiptDocumentId: String(receipt._id),
      });
      expect(payment.status).toBe(201);
      const staleWarning = {
        participantId: created.body._id,
        message: "Old duplicate: " + marker,
      };
      const [duplicateIdentity, duplicateReceipt] = await Document.create([
        {
          ownerId: admin._id,
          kind: "identity",
          status: "duplicate",
          fields: { iin },
          duplicate: staleWarning,
        },
        {
          ownerId: admin._id,
          kind: "receipt",
          status: "duplicate",
          fields: { amount: paid.amount },
          hash: receipt.hash,
          duplicate: staleWarning,
        },
      ]);
      const staleIdentityUrl = "/api/documents/" + duplicateIdentity._id;
      const staleReceiptUrl = "/api/documents/" + duplicateReceipt._id;
      expect((await agent.get(staleIdentityUrl)).body).toMatchObject({
        status: "duplicate",
        duplicate: { participantId: created.body._id },
      });
      if (archived)
        expect((await post(path + "/archive", {})).status).toBe(200);
      const list = (inArchive: boolean) =>
        agent
          .get("/api/participants")
          .query({ q: marker, archived: inArchive });
      expect(
        (await list(archived)).body.items.map((p: any) => p._id),
      ).toContain(created.body._id);
      const remove = () => agent.delete(path).set("x-csrf-token", csrf);
      expect((await request(app).delete(path)).status).toBe(403);
      expect((await agent.delete(path)).status).toBe(403);
      expect(
        (await remove().set("origin", "https://attacker.invalid")).status,
      ).toBe(403);
      expect((await agent.get(path)).status).toBe(200);
      await remove().expect(200, { ok: true });
      await remove().expect(200, { ok: true });
      for (const inArchive of [false, true]) {
        const listed = await list(inArchive);
        expect(listed.status).toBe(200);
        expect(listed.body.items.map((p: any) => p._id)).not.toContain(
          created.body._id,
        );
      }
      expect((await agent.get(path)).status).toBe(404);
      expect((await patch(path, participant)).status).toBe(404);
      expect((await post(path + "/archive", {})).status).toBe(404);
      expect((await post(path + "/archive", { restore: true })).status).toBe(
        404,
      );
      expect(
        (
          await post(path + "/payments", {
            ...paid,
            receiptNumber: "BLOCKED-" + marker,
          })
        ).status,
      ).toBe(404);
      expect(
        await Audit.countDocuments({
          entity: "Participant",
          entityId: created.body._id,
          action: "delete",
        }),
      ).toBe(1);
      expect((await stats()).body.finance.membership).toBe(
        priorIncome + paid.amount,
      );
      const saved = await Payment.findById(payment.body._id).orFail();
      expect(saved.amount).toBe(paid.amount);
      expect(saved.voidedAt).toBeNull();
      expect(String(saved.receiptDocumentId)).toBe(String(receipt._id));
      expect(
        (await agent.get("/api/documents/" + receipt._id)).body,
      ).toMatchObject({
        kind: "receipt",
        fields: { receiptNumber: paid.receiptNumber, amount: paid.amount },
      });
      const exported = await agent
        .get("/api/reports/payments?year=2081")
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(exported.status).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(exported.body);
      const historical = book
        .getWorksheet("Төлемдер")!
        .getSheetValues()
        .filter((r: any) => r?.includes(paid.receiptNumber));
      expect(historical).toHaveLength(1);
      expect(historical[0]).toContain("Жойылған қатысушы");
      const identityStatus = await agent.get(staleIdentityUrl).expect(200);
      expect(identityStatus.body.status).toBe("queued");
      expect(identityStatus.body.duplicate).toBeFalsy();
      expect(identityStatus.body.error).toBeFalsy();
      for (const status of [
        await agent.get(staleReceiptUrl),
        await post(staleReceiptUrl + "/refresh", {}),
      ]) {
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({
          status: "duplicate",
          duplicate: { paymentId: payment.body._id },
        });
        expect(status.body.duplicate.participantId).toBeUndefined();
        expect(status.body.error).not.toContain(marker);
        expect(status.body.hash).toBeUndefined();
      }
      const { completeRecognition } =
        await import("../server/services/duplicates.js");
      const complete = {
        iin,
        lastName: "Тегі",
        firstName: "Аты",
        lastNameLatin: "TEGI",
        firstNameLatin: "ATY",
        birthDate: "1980-01-01",
        documentNumber: "123456789",
        issuedBy: "МВД РК",
        issueDate: "2022-01-01",
        expiryDate: "2032-01-01",
      };
      await completeRecognition(duplicateIdentity, complete);
      const replacement = await post("/api/participants", {
        ...participant,
        identityDocumentId: String(
          archived ? duplicateIdentity._id : identity._id,
        ),
      });
      expect(replacement.status).toBe(201);
      expect(replacement.body._id).not.toBe(created.body._id);
      const duplicate = await post(
        "/api/participants/" + replacement.body._id + "/payments",
        paid,
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.paymentId).toBe(payment.body._id);
      expect(duplicate.body.participantId).toBeUndefined();
      const attached = await post(
        "/api/participants/" + replacement.body._id + "/payments",
        {
          ...paid,
          receiptNumber: "ALTERNATE-" + marker,
          receiptDocumentId: String(duplicateReceipt._id),
        },
      );
      expect(attached.status).toBe(409);
      expect(attached.body.paymentId).toBe(payment.body._id);
      expect(attached.body.participantId).toBeUndefined();
    },
  );
  it("exports five distinct workbooks with actual receipts, totals, local names and audience-specific columns", async () => {
    const { Participant, Payment, Finance, PaymentCategory } =
      await import("../server/models.js");
    const { REPORT_TITLES, reportFilename } =
      await import("../shared/report-names.js");
    const { ageAt, ageGroup, AGE_LABELS, RECEIPT_TYPES } =
      await import("../shared/domain.js");
    const year = 2044;
    const common = {
      lastName: "Есепсынақ",
      firstName: "Үлгі",
      middleName: "Қызы",
      region: "Мұнайлы ауданы",
      village: "Атамекен",
      birthDate: "1990-02-01",
      searchTokens: ["есепсынақ", "үлгі"],
    };
    const [a, b, c] = await Participant.create([
      {
        ...common,
        fullNameKk: "Қазақша Үлгі",
        fullNameRu: "Русское написание",
        lastNameLatin: "ESEPSYNAQ",
        firstNameLatin: "ULGI",
        phone: "+70000000001",
        iin: "001122000007",
        documentNumber: "012345678",
        sex: "Ер",
        citizenship: "Қазақстан",
        birthplace: "Маңғыстау облысы",
        issuedBy: "ҚР ІШКІ ІСТЕР МИНИСТРЛІГІ",
        issueDate: "2020-01-01",
        expiryDate: "2030-01-01",
      },
      // A different person with an identical native name must have a separate row.
      { ...common, phone: "+70000000002" },
      {
        ...common,
        region: "Ақтау",
        village: "Өмірзақ",
        firstName: "Әсел",
        birthDate: "",
      },
    ]);
    const archived = await Participant.create({
      ...common,
      firstName: "Мұрағат",
      region: "Ақтау",
      archivedAt: new Date(),
    });
    const [show, villageFee, otherFee, emptyFee] = await PaymentCategory.create(
      [
        { name: "Көрме", nameKey: "regional-test-show", amount: 650000 },
        {
          name: "Аудандық жарна",
          nameKey: "regional-test-village",
          amount: 560000,
        },
        {
          name: "Басқа мақсат",
          nameKey: "regional-test-other",
          amount: 560000,
        },
        { name: "Жаңа төлем", nameKey: "regional-test-empty", amount: 560000 },
      ],
    );
    // A long catalogue moves the participant table beyond Excel's frozen area.
    await PaymentCategory.insertMany(
      Array.from({ length: 9 }, (_, index) => ({
        name: `Қосымша сынақ ${index + 1}`,
        nameKey: `unused-provincial-fixture-${index}`,
        amount: 10000,
      })),
    );
    const payment = {
      participantId: a._id,
      year,
      paymentDate: "2044-03-01",
      paymentTime: "09:05",
      amount: 650000,
      receiptType: "personal",
    };
    await Payment.create([
      {
        ...payment,
        payerName: "Сынақ төлеуші",
        recipientName: "Сынақ алушы",
        receiptNumber: "R-ONE",
      },
      {
        ...payment,
        year: year + 1,
        paymentDate: "2044-03-02",
        paymentTime: "10:35:22",
        amount: 648700,
        receiptType: "urshyk",
        recipientName: "Ұршық ұйымы",
        receiptNumber: "R-TWO",
      },
      {
        ...payment,
        amount: 650000,
        paymentTime: "11:15",
        paymentKind: "additional",
        paymentCategoryId: show._id,
        paymentCategoryName: show.name,
        payerName: "Көрме төлеушісі",
        receiptNumber: "R-EXTRA",
      },
      {
        ...payment,
        participantId: b._id,
        amount: 560000,
        paymentTime: "",
        receiptType: "",
        receiptNumber: "R-THREE",
      },
      {
        ...payment,
        paymentKind: "additional",
        paymentCategoryId: villageFee._id,
        paymentCategoryName: villageFee.name,
        paymentTime: "09:44",
        amount: 150075,
        receiptNumber: "R-PARTIAL",
      },
      {
        ...payment,
        paymentKind: "additional",
        paymentCategoryId: otherFee._id,
        paymentCategoryName: otherFee.name,
        paymentTime: "",
        amount: 560000,
        receiptNumber: "R-OTHER",
      },
      { ...payment, amount: 888000, voidedAt: new Date() },
      {
        ...payment,
        participantId: archived._id,
        amount: 10150,
        paymentKind: "additional",
        paymentCategoryName: "Ескі төлем",
        receiptNumber: "R-ARCHIVED",
      },
    ]);
    await Finance.create([
      {
        type: "income",
        date: "2044-03-01",
        category: "Өзге сынақ",
        amount: 2355,
      },
      { type: "income", date: "2044-03-01", category: show.name, amount: 1000 },
      { type: "expense", date: "2044-03-01", category: "Шығыс", amount: 1100 },
      {
        type: "income",
        date: "2044-03-01",
        category: "Алып тасталды",
        amount: 9900,
        voidedAt: new Date(),
      },
    ]);
    const tableHeader = (sheet: ExcelJS.Worksheet) =>
      Number(/^A(\d+):/.exec(String(sheet.autoFilter))?.[1]);
    const exportBook = async (
      type: keyof typeof REPORT_TITLES,
      filter = "",
    ) => {
      const result = await agent
        .get(`/api/reports/${type}?year=${year}&limit=1${filter}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toContain(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(
        decodeURIComponent(result.headers["content-disposition"]),
      ).toContain(reportFilename(type, year));
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(result.body);
      for (const sheet of book.worksheets) {
        expect(sheet.getCell("A1").text).toContain(REPORT_TITLES[type]);
        expect(sheet.getCell("A1").text).toContain(String(year));
        expect(sheet.getCell("A2").text.length).toBeGreaterThan(15);
        const view = sheet.views[0];
        const header = tableHeader(sheet);
        expect(view.state).toBe(header > 10 ? "normal" : "frozen");
        if (view.state === "frozen") expect(view.ySplit).toBe(header);
        expect(sheet.autoFilter).toBe(
          `A${header}:${sheet.getCell(sheet.rowCount, sheet.columnCount).address}`,
        );
      }
      return book;
    };
    const records = (sheet: ExcelJS.Worksheet) => {
      const header = tableHeader(sheet);
      const rows = [];
      for (let n = header + 1; n <= sheet.rowCount; n++) {
        const row: Record<string, ExcelJS.CellValue> = {};
        sheet.getRow(header).eachCell((cell, i) => {
          row[cell.text] = sheet.getCell(n, i).value;
        });
        rows.push(row);
      }
      return rows;
    };
    const regional = await exportBook(
      "mangystau-oblast",
      "&region=" + encodeURIComponent(common.region),
    );
    const summary = regional.worksheets[0];
    expect(summary.getCell("C3").value).toBe(32322.8);
    expect(summary.getCell("E3").value).toBe(32289.25);
    expect(summary.getCell("G3").value).toBe(33.55);
    expect(summary.getCell("I3").value).toBe(6500);
    const headerRow = tableHeader(summary);
    expect(headerRow).toBeGreaterThan(10);
    expect(summary.getRow(4).values).toContain("Кіріс түрі бойынша, ₸");
    const byType = new Map<string, number>();
    for (let n = 5; n < headerRow; n++) {
      for (const col of [2, 4]) {
        const category = summary.getCell(n, col).text;
        if (n < headerRow - 1) expect(category).not.toBe("");
        if (!category) continue;
        const amount = summary.getCell(n, col + 1).value;
        expect(typeof amount).toBe("number");
        expect(byType.has(category)).toBe(false);
        byType.set(category, Number(amount));
      }
    }
    expect(Object.fromEntries(byType)).toMatchObject({
      "Мүшелік жарна": 18587,
      "Аудандық жарна": 1500.75,
      "Басқа мақсат": 5600,
      Көрме: 6510,
      "Жаңа төлем": 0,
      "Ескі төлем": 101.5,
      "Өзге сынақ": 23.55,
    });
    expect(byType.has("Алып тасталды")).toBe(false);
    expect(byType.has("Шығыс")).toBe(false);
    expect(
      [...byType.values()].reduce(
        (sum, amount) => sum + Math.round(amount * 100),
        0,
      ),
    ).toBe(3232280);
    const registered = records(summary).filter((r) =>
      String(r["Аты-жөні (құжат бойынша)"]).startsWith("Есепсынақ "),
    );
    expect(registered).toHaveLength(4);
    const twin = registered.find((r) => r["Телефон"] === a.phone)!;
    expect(Object.keys(twin)).toEqual([
      "№",
      "Аты-жөні (құжат бойынша)",
      "Туған күні",
      "Телефон",
      "Жасы",
      "Жас санаты",
      "Аймақ",
      "Мүшелік жарна (6 500 ₸)",
      "Аудандық жарна, ₸",
      "Басқа мақсат, ₸",
      "Ескі төлем, ₸",
      "Көрме, ₸",
      "Барлығы, ₸",
      "Жіберуші",
      "Алушы",
      "Елді мекен",
    ]);
    const age = ageAt(common.birthDate);
    expect(twin).toMatchObject({
      "Аты-жөні (құжат бойынша)": "Есепсынақ Үлгі Қызы",
      Жасы: age,
      "Жас санаты": AGE_LABELS[ageGroup(age)!],
      "Елді мекен": "Атамекен",
      "Барлығы, ₸": 26587.75,
      "Туған күні": new Date("1990-02-01T00:00Z"),
    });
    const purposeLines = (
      row: Record<string, ExcelJS.CellValue>,
      column: string,
    ) =>
      String(row[column] ?? "")
        .split("\n")
        .filter(Boolean);
    expect(purposeLines(twin, "Мүшелік жарна (6 500 ₸)")).toEqual([
      "1. 6\u202f487 ₸ · 02.03.2044 10:35:22",
      "4. 6\u202f500 ₸ · 01.03.2044 09:05",
    ]);
    expect(purposeLines(twin, "Көрме, ₸")).toEqual([
      "2. 6\u202f500 ₸ · 01.03.2044 11:15",
    ]);
    expect(purposeLines(twin, "Аудандық жарна, ₸")).toEqual([
      "3. 1\u202f500,75 ₸ · 01.03.2044 09:44",
    ]);
    expect(purposeLines(twin, "Басқа мақсат, ₸")).toEqual([
      "5. 5\u202f600 ₸ · 01.03.2044",
    ]);
    expect(String(twin["Ескі төлем, ₸"] ?? "")).toBe("");
    expect(String(twin["Жіберуші"]).split("\n")).toEqual([
      "1. —",
      "2. Көрме төлеушісі",
      "3. —",
      "4. Сынақ төлеуші",
      "5. —",
    ]);
    expect(String(twin["Алушы"]).split("\n")).toEqual([
      "1. Ұршық ұйымы",
      "2. —",
      "3. —",
      "4. Сынақ алушы",
      "5. —",
    ]);
    const otherTwin = registered.find((r) => r["Телефон"] === b.phone)!;
    expect(otherTwin).toMatchObject({
      "Аты-жөні (құжат бойынша)": twin["Аты-жөні (құжат бойынша)"],
      "Мүшелік жарна (6 500 ₸)": "5\u202f600 ₸ · 01.03.2044",
      "Барлығы, ₸": 5600,
      Жіберуші: "—",
      Алушы: "—",
    });
    expect(
      registered.find((row) => row["№"] === archived.registrationNumber),
    ).toMatchObject({
      "Ескі төлем, ₸": "101,50 ₸ · 01.03.2044 09:05",
      "Барлығы, ₸": 101.5,
    });
    const unpaid = registered.find((r) => r["Елді мекен"] === c.village)!;
    expect(unpaid).toMatchObject({
      "Барлығы, ₸": 0,
      Жасы: null,
      "Жас санаты": null,
      "Туған күні": null,
    });
    for (const purpose of [
      "Мүшелік жарна (6 500 ₸)",
      "Аудандық жарна, ₸",
      "Басқа мақсат, ₸",
      "Ескі төлем, ₸",
      "Көрме, ₸",
    ])
      expect(String(unpaid[purpose] ?? "")).toBe("");
    for (const key of ["Жіберуші", "Алушы"])
      expect(String(unpaid[key] ?? "")).toMatch(/^(?:—)?$/);
    const ledger = records(regional.worksheets[1]);
    const numbers = registered.map((r) => r["№"]);
    expect(numbers.every((n) => typeof n === "number" && n > 0)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((x, y) => Number(x) - Number(y)));
    expect(ledger.find((r) => r["Чек нөмірі"] === "R-ONE")?.["№"]).toBe(
      twin["№"],
    );
    expect(ledger.find((r) => r["Чек нөмірі"] === "R-THREE")?.["№"]).toBe(
      otherTwin["№"],
    );
    expect(ledger).toHaveLength(7);
    expect(ledger[0]["Чек нөмірі"]).toBe("R-TWO");
    const amountAndTime = "Сома, күні мен уақыты (Астана)";
    for (const obsolete of [
      "Чек",
      "Сома, ₸",
      "Чек күні мен уақыты (Астана)",
      "Төлем күні мен уақыты (Астана)",
    ])
      expect(Object.keys(ledger[0])).not.toContain(obsolete);
    expect(ledger[0]).toMatchObject({
      [amountAndTime]: "6\u202f487 ₸ · 02.03.2044 10:35:22",
      "Чек түрі": RECEIPT_TYPES.urshyk,
      "Төлем мақсаты": "Мүшелік жарна",
    });
    expect(ledger.find((r) => r["Чек нөмірі"] === "R-PARTIAL")).toMatchObject({
      [amountAndTime]: "1\u202f500,75 ₸ · 01.03.2044 09:44",
      "Чек түрі": RECEIPT_TYPES.personal,
      "Төлем мақсаты": "Аудандық жарна",
    });
    expect(
      ledger.find((r) => r["Чек нөмірі"] === "R-THREE")?.[amountAndTime],
    ).toBe("5\u202f600 ₸ · 01.03.2044");
    expect(ledger.find((r) => r["Чек нөмірі"] === "R-ONE")).toMatchObject({
      Жіберуші: "Сынақ төлеуші",
      Алушы: "Сынақ алушы",
      "Төлем мақсаты": "Мүшелік жарна",
    });
    const otherIncome = records(regional.worksheets[2]);
    expect(otherIncome.map((entry) => entry["Сомасы мен күні"]).sort()).toEqual(
      ["10 ₸ · 01.03.2044", "23,55 ₸ · 01.03.2044"],
    );
    expect(Object.keys(otherIncome[0])).toEqual([
      "Сомасы мен күні",
      "Санат",
      "Түсініктеме",
    ]);
    const district = await exportBook(
      "mangystau-district",
      "&region=" + encodeURIComponent(common.region),
    );
    expect(district.worksheets[0].getCell("B3").value).toBe(13600.75);
    expect(district.worksheets[0].getRow(4).values).toContain(
      "Қазақша аты-жөні",
    );
    expect(district.worksheets[0].getRow(4).values).toContain(
      "Соңғы чек күні мен уақыты (Астана)",
    );
    expect(district.worksheets[1].getRow(3).values).toContain("Төлеген адам");
    expect(district.worksheets[1].getRow(3).values).not.toContain("Чек");
    const districtTwins = records(district.worksheets[0]).filter((r) =>
      [a.phone, b.phone].includes(String(r["Телефон"])),
    );
    expect(districtTwins.map((r) => r["Телефон"])).toEqual([a.phone, b.phone]);
    expect(
      records(district.worksheets[1])
        .map((r) => r["Чек нөмірі"])
        .sort(),
    ).toEqual(["R-EXTRA", "R-OTHER", "R-PARTIAL"]);
    expect(district.worksheets[0].getRow(4).values).not.toContain(
      "Мүшелік жарна, ₸",
    );
    for (const [category, expected] of [
      [villageFee, 1500.75],
      [emptyFee, 0],
    ] as const) {
      const book = await exportBook(
        "mangystau-district",
        "&region=" +
          encodeURIComponent(common.region) +
          "&paymentCategoryId=" +
          category.id,
      );
      expect(book.worksheets[0].getCell("A2").text).toContain(category.name);
      expect(book.worksheets[0].getCell("B3").value).toBe(expected);
      const rows = records(book.worksheets[0]);
      expect(rows.find((r) => r["Телефон"] === a.phone)).toMatchObject({
        [category.name + ", ₸"]: expected,
        "Барлығы, ₸": expected,
      });
      expect(rows.find((r) => r["Телефон"] === b.phone)).toMatchObject({
        [category.name + ", ₸"]: 0,
        "Барлығы, ₸": 0,
      });
      expect(records(book.worksheets[1]).map((r) => r["Чек нөмірі"])).toEqual(
        expected ? ["R-PARTIAL"] : [],
      );
    }
    expect(
      (
        await agent.get(
          "/api/reports/mangystau-district?paymentCategoryId=wrong-id",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await agent.get(
          "/api/reports/mangystau-district?paymentCategoryId=" +
            new mongoose.Types.ObjectId(),
        )
      ).status,
    ).toBe(404);
    for (const book of [regional, district]) {
      const all = JSON.stringify(
        book.worksheets.map((s) => s.getSheetValues()),
      );
      for (const privateField of [
        "ЖСН",
        "Куәлік нөмірі",
        "Кім берді",
        "Жарамдылық мерзімі",
        a.iin,
        a.documentNumber,
      ])
        expect(all).not.toContain(privateField);
    }
    const ourPeople = (sheet: ExcelJS.Worksheet) =>
      records(sheet).filter((row) =>
        String(row["Аты-жөні (құжат бойынша)"])
          .split("\n")
          .some((name) => name.startsWith(common.lastName + " ")),
      );
    const withNames = "&status=paid"; // Lists include unpaid members, even if an obsolete client sends a financial filter.
    const awards = ourPeople(
      (await exportBook("awards", withNames)).worksheets[0],
    );
    for (const type of ["awards", "international"] as const) {
      const byTerritory = await exportBook(
        type,
        "&region=" + encodeURIComponent(common.region),
      );
      expect(byTerritory.worksheets[0].getCell("A2").text).toContain(
        common.region,
      );
      expect(ourPeople(byTerritory.worksheets[0])).toHaveLength(2);
    }
    expect(awards).toHaveLength(3);
    expect(awards[0]["Елді мекен"]).toBe("Өмірзақ");
    expect(Object.keys(awards[0])).toEqual([
      "Аты-жөні (құжат бойынша)",
      "Аймақ",
      "Елді мекен",
    ]);
    const internationalSheet = (await exportBook("international", withNames))
      .worksheets[0];
    expect(
      new Set(records(internationalSheet).map((row) => row["Жынысы"])),
    ).toEqual(new Set(["Әйел"]));
    expect((await Participant.findById(a._id).lean())?.sex).toBe("Ер");
    const international = ourPeople(internationalSheet);
    expect(international).toHaveLength(3);
    expect(internationalSheet.getCell("A1").text).toBe(
      "Шетел рекорд Гиннеса · 2044 жыл",
    );
    expect(Object.keys(international[0])).toEqual([
      "Аты-жөні (құжат бойынша)",
      "Туған күні",
      "Жынысы",
      "Азаматтығы",
      "Туған жері",
      "Куәлік нөмірі",
      "Кім берді",
      "Жарамдылық мерзімі",
    ]);
    expect(
      international.find((r) => r["Куәлік нөмірі"] === "012345678"),
    ).toMatchObject({
      "Аты-жөні (құжат бойынша)": "ESEPSYNAQ ULGI\nЕсепсынақ Үлгі Қызы",
      "Туған күні": new Date("1990-02-01T00:00:00Z"),
      Жынысы: "Әйел",
      Азаматтығы: a.citizenship,
      "Туған жері": a.birthplace,
      "Кім берді": a.issuedBy,
      "Жарамдылық мерзімі": "01.01.2020 — 01.01.2030",
    });
    const rowsAsText = JSON.stringify(internationalSheet.getSheetValues());
    expect(rowsAsText).not.toContain(String(a.iin));
    expect(rowsAsText).not.toMatch(/\bIIN\b|ЖСН|ИИН/u);
    expect(
      international.find(
        (r) => r["Аты-жөні (құжат бойынша)"] === "Есепсынақ Әсел Қызы",
      ),
    ).toMatchObject({
      "Туған күні": null,
      Жынысы: "Әйел",
      Азаматтығы: "",
      "Туған жері": "",
    });
    const [registration, fixedRegistration] = await PaymentCategory.create([
      {
        name: "Тіркеу ақысы",
        nameKey: "urshyk-test-registration",
        amount: 160000,
      },
      {
        name: "1600 тенге",
        nameKey: "urshyk-test-fixed-registration",
        amount: 160000,
      },
    ]);
    const [memberOnly, hidden, deleted] = await Participant.create([
      { lastName: "Жарнасынақ", firstName: "Үлгі", region: "Бейнеу ауданы" },
      { ...common, firstName: "Жасырылған", siteHiddenAt: new Date() },
      { ...common, firstName: "Жойылған", deletedAt: new Date() },
    ]);
    const signup = {
      ...payment,
      amount: 160000,
      paymentKind: "additional",
      paymentCategoryId: registration._id,
      paymentCategoryName: registration.name,
    };
    await Payment.create([
      signup,
      { ...signup, participantId: c._id, paymentDate: "2044-01-01" },
      {
        ...signup,
        participantId: c._id,
        paymentCategoryId: fixedRegistration._id,
        // A legacy payment kept only the reference to its "1600 тенге" category.
        paymentCategoryName: "",
        paymentDate: "2044-12-31",
      },
      {
        ...signup,
        participantId: b._id,
        paymentCategoryId: undefined,
        paymentCategoryName: "Зал арендасы — 1600 теңге",
      },
      { ...signup, participantId: b._id, amount: 159900 },
      { ...signup, participantId: b._id, paymentDate: "2045-01-01" },
      { ...signup, participantId: b._id, voidedAt: new Date() },
      ...[archived, hidden, deleted].map((person) => ({
        ...payment,
        participantId: person._id,
      })),
    ]);
    // Historical payments written before paymentKind existed have no model default.
    await Payment.collection.insertOne({
      ...payment,
      participantId: memberOnly._id,
    });
    const moneyHeaders = ["Мүшелік жарна, ₸", "Тіркеу ақысы, ₸", "Барлығы, ₸"];
    async function republican(region: string, expectedTotals: number[]) {
      const book = await exportBook(
        "urshyk",
        region ? "&region=" + encodeURIComponent(region) : "",
      );
      expect(book.worksheets).toHaveLength(1);
      const sheet = book.worksheets[0];
      if (region) expect(sheet.getCell("A2").text).toContain(region);
      expect(
        ["B3", "D3", "F3"].map((address) => sheet.getCell(address).value),
      ).toEqual(expectedTotals);
      const headers = (
        sheet.getRow(tableHeader(sheet)).values as ExcelJS.CellValue[]
      ).slice(1);
      expect(headers).toEqual([
        ...Object.keys(international[0]),
        ...moneyHeaders,
      ]);
      const rows = records(sheet);
      for (const [index, header] of moneyHeaders.entries()) {
        expect(
          rows.reduce((total, row) => total + Number(row[header]), 0),
        ).toBe(expectedTotals[index]);
      }
      expect(JSON.stringify(sheet.getSheetValues())).not.toContain(
        String(a.iin),
      );
      return rows;
    }
    const resultingRows = await republican("", [19487, 4800, 24287]);
    expect(resultingRows).toHaveLength(3);
    const memberA = resultingRows.find(
      (r) => r["Куәлік нөмірі"] === a.documentNumber,
    );
    expect(memberA).toMatchObject({
      "Аты-жөні (құжат бойынша)": "ESEPSYNAQ ULGI\nЕсепсынақ Үлгі Қызы",
      "Туған күні": new Date("1990-02-01T00:00Z"),
      Жынысы: a.sex,
      Азаматтығы: a.citizenship,
      "Туған жері": a.birthplace,
      "Кім берді": a.issuedBy,
      "Жарамдылық мерзімі": "01.01.2020 — 01.01.2030",
      "Мүшелік жарна, ₸": 12987,
      "Тіркеу ақысы, ₸": 1600,
      "Барлығы, ₸": 14587,
    });
    expect(await republican(common.region, [12987, 1600, 14587])).toEqual([
      memberA,
    ]);
    expect(await republican("Ақтау", [0, 3200, 3200])).toEqual([
      expect.objectContaining({
        "Аты-жөні (құжат бойынша)": "Есепсынақ Әсел Қызы",
        "Мүшелік жарна, ₸": 0,
        "Тіркеу ақысы, ₸": 3200,
        "Барлығы, ₸": 3200,
      }),
    ]);
    expect(await republican("Бейнеу ауданы", [6500, 0, 6500])).toEqual([
      expect.objectContaining({
        "Аты-жөні (құжат бойынша)": "Жарнасынақ Үлгі",
        "Мүшелік жарна, ₸": 6500,
        "Тіркеу ақысы, ₸": 0,
        "Барлығы, ₸": 6500,
      }),
    ]);
    expect(await republican("Қарақия ауданы", [0, 0, 0])).toEqual([]);
  });
  it("omits hidden profiles from rosters and keeps their actual money in the ledger", async () => {
    const { Participant, Payment } = await import("../server/models.js");
    const { makeReport, financialSummary } =
      await import("../server/services/reports.js");
    const { filtersSchema } = await import("../server/services/members.js");
    const profile = await Participant.create({
      lastName: "HiddenReportFixture",
      phone: "hidden-phone-fixture",
      region: "Ақтау",
      siteHiddenAt: new Date(),
    });
    const year = 2094;
    await Payment.create({
      participantId: profile._id,
      year,
      paymentDate: "2094-03-01",
      amount: 650000,
      paymentKind: "additional",
      paymentCategoryName: "Есеп сынағы",
      receiptNumber: "LEDGER-FIXTURE",
    });
    expect((await financialSummary(year)).totalIncome).toBe(650000);
    const types = [
      "members",
      "awards",
      "urshyk",
      "international",
      "payments",
      "mangystau-oblast",
      "mangystau-district",
    ] as const;
    for (const type of types) {
      const filters = filtersSchema.parse({
        year,
        region: type === "mangystau-district" ? "Ақтау" : "",
      });
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await makeReport(type, filters));
      const cells = book.worksheets.flatMap((sheet) =>
        sheet.getSheetValues().flat(2),
      );
      expect(cells).not.toContain("HiddenReportFixture");
      expect(cells).not.toContain("hidden-phone-fixture");
      const ledger = book.getWorksheet("Төлемдер");
      if (ledger) {
        const labels = ledger.getRow(3).values as ExcelJS.CellValue[];
        const value = (label: string) =>
          ledger.getCell(4, labels.indexOf(label)).value;
        expect(value("Қатысушы")).toBe("Жасырылған қатысушы");
        expect(value("Чек нөмірі")).toBe("LEDGER-FIXTURE");
        if (type === "mangystau-oblast") {
          expect(value("№")).toBeNull();
          expect(value("Сома, күні мен уақыты (Астана)")).toBe(
            "6\u202f500 ₸ · 01.03.2094",
          );
        } else {
          expect(value("Сома, ₸")).toBe(6500);
        }
      } else {
        expect(cells).not.toContain("Жасырылған қатысушы");
      }
    }
  });
  it("keeps a server-issued participant number across edits, archiving and deletion", async () => {
    const { Participant } = await import("../server/models.js");
    const create = await post("/api/participants", {
      firstName: "Numbered",
      registrationNumber: 99999999,
    });
    expect(create.status).toBe(201);
    const { _id, registrationNumber } = create.body;
    expect(Number.isSafeInteger(registrationNumber)).toBe(true);
    expect(registrationNumber).toBeGreaterThan(0);
    expect(registrationNumber).not.toBe(99999999);
    const url = `/api/participants/${_id}`;
    const edit = await patch(url, {
      firstName: "Renamed",
      registrationNumber: registrationNumber + 1000,
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({
      firstName: "Renamed",
      registrationNumber,
    });
    const list = await agent.get("/api/participants").query({ q: "Renamed" });
    expect(list.body.items).toContainEqual(
      expect.objectContaining({ _id, registrationNumber }),
    );
    for (const restore of [false, true]) {
      expect((await post(`${url}/archive`, { restore })).status).toBe(200);
      expect((await agent.get(url)).body.registrationNumber).toBe(
        registrationNumber,
      );
    }
    expect((await agent.delete(url).set("x-csrf-token", csrf)).status).toBe(
      200,
    );
    expect((await agent.get(url)).status).toBe(404);
    const tombstone = await Participant.findById(_id).lean();
    expect(tombstone).toMatchObject({
      registrationNumber,
      deletedAt: expect.any(Date),
    });
    const next = await post("/api/participants", { firstName: "Numbered" });
    expect(next.status).toBe(201);
    expect(next.body.registrationNumber).toBeGreaterThan(registrationNumber);
  });
  it("assigns distinct numbers to simultaneous registrations and preserves imported numbers on retries", async () => {
    const { Participant } = await import("../server/models.js");
    const created = await Promise.all(
      ["Алма", "Балжан", "Сәуле", "Гүлнәр"].map((firstName) =>
        post("/api/participants", {
          lastName: "NumberConcurrencyFixture",
          firstName,
        }),
      ),
    );
    for (const result of created) expect(result.status).toBe(201);
    const numbers = created.map((r) => r.body.registrationNumber);
    expect(numbers.every((n) => Number.isSafeInteger(n) && n > 0)).toBe(true);
    expect(new Set(numbers).size).toBe(created.length);
    const lastName = "NumberImportFixture";
    const bytes = await workbookBytes(
      [
        [lastName, "Алма", "1970-05-04"],
        [lastName, "Айша", "1982-01-01"],
      ],
      ["Фамилия", "Имя", "Дата рождения"],
    );
    const preview = await previewFile(bytes);
    expect(preview.body).toMatchObject({ ready: 2, errorCount: 0 });
    const url = `/api/participants/import/${preview.body.draftId}/commit`;
    expect((await post(url, {})).body.created).toBe(2);
    const imported = () =>
      Participant.find({ lastName })
        .select("_id registrationNumber")
        .sort({ _id: 1 })
        .lean();
    const first = await imported();
    expect(first).toHaveLength(2);
    const importNumbers = first.map((p) => p.registrationNumber);
    expect(
      importNumbers.every(
        (n) => Number.isSafeInteger(n) && Number(n) > Math.max(...numbers),
      ),
    ).toBe(true);
    expect(new Set(importNumbers).size).toBe(2);
    expect((await post(url, {})).status).toBe(200);
    const retry = await previewFile(bytes);
    expect(retry.body).toMatchObject({ ready: 0, duplicates: 2 });
    expect(await imported()).toEqual(first);
  });
  it("backfills existing registrations in order and preserves numbers across a second migration", async () => {
    const { Participant } = await import("../server/models.js");
    const { initializeRegistrationNumbers, backfillRegistrationNumbers } =
      await import("../server/services/registration-numbers.js");
    const highest = await Participant.findOne()
      .sort({ registrationNumber: -1 })
      .lean();
    const reserved = (highest?.registrationNumber ?? 0) + 20;
    const started = new Date("2020-01-01T00:00:00Z");
    const later = new Date("2021-01-01T00:00:00Z");
    const result = await Participant.collection.insertMany([
      { firstName: "Archived", archivedAt: started, createdAt: started },
      { firstName: "Later", createdAt: later },
      { firstName: "Earlier", createdAt: started },
      { firstName: "Hidden", siteHiddenAt: started },
      { deletedAt: started },
      { registrationNumber: reserved, deletedAt: later },
      { firstName: "AlreadyNumbered", registrationNumber: reserved - 1 },
    ]);
    const rows = async () => {
      const people = await Participant.find({
        _id: { $in: Object.values(result.insertedIds) },
      }).lean();
      expect(people).toHaveLength(result.insertedCount);
      return Object.values(result.insertedIds).map(
        (id) => people.find((p) => p._id.equals(id))?.registrationNumber,
      );
    };
    await initializeRegistrationNumbers();
    await backfillRegistrationNumbers();
    const assigned = await rows();
    expect(assigned[2]).toBeGreaterThan(reserved);
    expect(assigned[1]).toBeGreaterThan(assigned[2]!);
    expect(assigned[0]).toBeGreaterThan(assigned[1]!);
    expect(assigned.slice(3)).toEqual([
      undefined,
      undefined,
      reserved,
      reserved - 1,
    ]);
    await backfillRegistrationNumbers();
    expect(await rows()).toEqual(assigned);
    const next = await post("/api/participants", {
      firstName: "AfterMigration",
    });
    expect(next.status).toBe(201);
    expect(next.body.registrationNumber).toBeGreaterThan(assigned[0]!);
  });
  it("writes audit logs and invalidates the session on logout", async () => {
    const { Audit } = await import("../server/models.js");
    expect(await Audit.countDocuments()).toBeGreaterThan(10);
    expect((await post("/api/auth/logout", {})).status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});
