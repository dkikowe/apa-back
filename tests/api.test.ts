import { beforeAll, afterAll, describe, it, expect } from "vitest";
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
  it("detects duplicate receipts and requires explicit confirmation", async () => {
    expect(
      (await post(`/api/participants/${participantId}/payments`, base)).status,
    ).toBe(409);
    const r = await post(`/api/participants/${participantId}/payments`, {
      ...base,
      confirmDuplicate: true,
    });
    expect(r.status).toBe(201);
    await post(`/api/payments/${r.body._id}/void`, {});
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
  it("writes audit logs and invalidates the session on logout", async () => {
    const { Audit } = await import("../server/models.js");
    expect(await Audit.countDocuments()).toBeGreaterThan(10);
    expect((await post("/api/auth/logout", {})).status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});
