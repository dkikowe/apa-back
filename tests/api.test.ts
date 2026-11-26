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
    expect(book.worksheets[0].rowCount).toBe(2);
    expect(book.worksheets[0].getCell("B2").value).toBe("Меруерт");
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
      error: "OCR unavailable",
      key: "synthetic/key",
      hash: "synthetic",
    });
    const state = await agent.get(`/api/documents/${doc._id}`);
    expect(state.body.status).toBe("failed");
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
    expect(workbook.worksheets[0].rowCount).toBe(4);
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

  it("saves optional identity details and preserves document leading zeros", async () => {
    const identity = {
      iin: "000123456789",
      documentNumber: "001234567",
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
    });
    expect(changed.status).toBe(200);
    expect(changed.body.documentNumber).toBe("001234567");
    expect(changed.body.issuedBy).toBe("");
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
    const sheet = book.worksheets[0];
    expect(sheet.getRow(1).values).toContain("Төлем уақыты");
    expect(sheet.getColumn(4).values.slice(2)).toEqual([
      "15:08:03",
      "15:08",
      "09:30",
      "",
      "23:59:59",
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
    expect(book.worksheets[0].getRow(1).values).toContain("Төлеген адам");
    expect(book.worksheets[0].getRow(2).values).toContain("Үлгі Ә.");

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
      { $set: { status: "done", attempts: 3 } },
    );
    expect((await post(`/api/documents/${doc._id}/retry`, {})).status).toBe(
      400,
    );
    await Document.updateOne(
      { _id: doc._id },
      { $set: { attempts: 1, ownerId: new mongoose.Types.ObjectId() } },
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
  it("rejects an already uploaded file before storage, even if the filename changes", async () => {
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
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        duplicateDocumentId: original.body.id,
        canReuse: true,
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
    expect(checked).toMatchObject({
      status: "duplicate",
      duplicate: { duplicateDocumentId: String(original._id), canReuse: true },
    });
    expect(
      (
        await post("/api/participants", {
          ...person,
          iin: fields.iin,
          identityDocumentId: String(copy._id),
        })
      ).status,
    ).toBe(409);
    const saved = await post("/api/participants", {
      ...person,
      iin: fields.iin,
      identityDocumentId: String(original._id),
    });
    expect(saved.status).toBe(201);
    await completeRecognition(await Document.findById(original._id), fields);
    expect((await Document.findById(original._id))?.status).toBe("done");
    const another = await make();
    await completeRecognition(another, fields);
    expect((await Document.findById(another._id))?.duplicate).toMatchObject({
      participantId: saved.body._id,
    });
  });
  it("blocks recognized receipt duplicates of saved payments and competing unfinished uploads", async () => {
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
    expect(docs.map((d) => d.status).sort()).toEqual(["done", "duplicate"]);
    const loser = docs.find((d) => d.status === "duplicate")!;
    expect(
      (
        await post(`/api/participants/${participantId}/payments`, {
          ...base,
          receiptNumber: "QR-RACE-412",
          receiptDocumentId: String(loser._id),
        })
      ).status,
    ).toBe(409);
    const winner = docs.find((d) => d.status === "done")!;
    const saved = await post(`/api/participants/${participantId}/payments`, {
      ...base,
      receiptNumber: "QR-RACE-412",
      receiptDocumentId: String(winner._id),
    });
    expect(saved.status).toBe(201);
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
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const original = results.find((r) => r.status === 201)!;
      expect(
        results.find((r) => r.status === 409)!.body.duplicateDocumentId,
      ).toBe(original.body.id);
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
  it("writes audit logs and invalidates the session on logout", async () => {
    const { Audit } = await import("../server/models.js");
    expect(await Audit.countDocuments()).toBeGreaterThan(10);
    expect((await post("/api/auth/logout", {})).status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});
