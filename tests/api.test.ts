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
  it("writes audit logs and invalidates the session on logout", async () => {
    const { Audit } = await import("../server/models.js");
    expect(await Audit.countDocuments()).toBeGreaterThan(10);
    expect((await post("/api/auth/logout", {})).status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});
