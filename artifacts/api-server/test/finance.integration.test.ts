import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import express from "express";
import pg from "pg";

const { Pool } = pg;
const originalDatabaseUrl = process.env.DATABASE_URL;
if (!originalDatabaseUrl) {
  throw new Error("DATABASE_URL must be set to run finance integration tests.");
}

const schemaName = `carteras_it_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: originalDatabaseUrl });
const schema = `"${schemaName}"`;
let testDb: typeof import("@workspace/db") | undefined;
let testServer: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";
let testClerkId = `integration_${randomUUID()}`;

function withTestSchema(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("options", `-c search_path=${schemaName},public`);
  return parsed.toString();
}

async function prepareSchema(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const tables = [
    "app_users",
    "clients",
    "loans",
    "installments",
    "payments",
    "audit_events",
  ];
  for (const table of tables) {
    await adminPool.query(
      `CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }

  for (const table of ["clients", "loans", "payments"]) {
    const sequence = `"${schemaName}"."${table}_code_number_seq"`;
    await adminPool.query(
      `CREATE SEQUENCE "${schemaName}"."${table}_code_number_seq"`,
    );
    await adminPool.query(
      `ALTER TABLE ${schema}."${table}" ALTER COLUMN code_number SET DEFAULT nextval('${sequence}'::regclass)`,
    );
    await adminPool.query(
      `ALTER SEQUENCE "${schemaName}"."${table}_code_number_seq" OWNED BY ${schema}."${table}".code_number`,
    );
  }

  await adminPool.query(
    `ALTER TABLE ${schema}.loans ADD CONSTRAINT it_loans_client_fk FOREIGN KEY (client_id) REFERENCES ${schema}.clients(id), ADD CONSTRAINT it_loans_user_fk FOREIGN KEY (created_by) REFERENCES ${schema}.app_users(id)`,
  );
  await adminPool.query(
    `ALTER TABLE ${schema}.installments ADD CONSTRAINT it_installments_loan_fk FOREIGN KEY (loan_id) REFERENCES ${schema}.loans(id)`,
  );
  await adminPool.query(
    `ALTER TABLE ${schema}.payments ADD CONSTRAINT it_payments_client_fk FOREIGN KEY (client_id) REFERENCES ${schema}.clients(id), ADD CONSTRAINT it_payments_loan_fk FOREIGN KEY (loan_id) REFERENCES ${schema}.loans(id), ADD CONSTRAINT it_payments_installment_fk FOREIGN KEY (installment_id) REFERENCES ${schema}.installments(id), ADD CONSTRAINT it_payments_user_fk FOREIGN KEY (registered_by) REFERENCES ${schema}.app_users(id)`,
  );
  await adminPool.query(
    `ALTER TABLE ${schema}.audit_events ADD CONSTRAINT it_audit_user_fk FOREIGN KEY (user_id) REFERENCES ${schema}.app_users(id)`,
  );
}

async function startTestApi(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.clerkUserId = testClerkId;
    next();
  });
  const { default: financeRouter } = await import("../src/routes/finance.ts");
  app.use("/api", financeRouter);
  testServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    testServer?.once("listening", resolve);
    testServer?.once("error", reject);
  });
  const address = testServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test API did not open a TCP port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}/api`;
}

async function stopTestApi(): Promise<void> {
  if (!testServer) return;
  await new Promise<void>((resolve, reject) => {
    testServer?.close((error) => (error ? reject(error) : resolve()));
  });
  testServer = undefined;
}

async function request<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: data ? { "content-type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

function dateOffset(days: number): string {
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const value = new Date(`${localToday}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

after(async () => {
  await stopTestApi();
  if (testDb) {
    await testDb.pool.end();
  }
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
  process.env.DATABASE_URL = originalDatabaseUrl;
});

test(
  "finance routes preserve separate loans, installments, payments, and audit records",
  { timeout: 120_000 },
  async () => {
    await prepareSchema();
    process.env.DATABASE_URL = withTestSchema(originalDatabaseUrl);
    testDb = await import("@workspace/db");
    const { appUsersTable, db } = testDb;
    await db.insert(appUsersTable).values({
      clerkUserId: testClerkId,
      name: "Operador de integração",
      email: `${testClerkId}@example.invalid`,
      role: "ADMIN",
    });
    await startTestApi();

    const clientResult = await request<{
      id: string;
      code: string;
      fullName: string;
    }>("/clients", "POST", {
      fullName: "Cliente de teste isolado",
      phone1: "11999990000",
      documentType: "OUTRO",
      documentNumber: `IT-${randomUUID()}`,
    });
    assert.equal(clientResult.status, 201);
    assert.match(clientResult.body.code, /^CL-\d{6}$/);

    const duplicateClient = await request<{ error: string }>(
      "/clients",
      "POST",
      {
        fullName: "Documento duplicado",
        phone1: "11888880000",
        documentType: "OUTRO",
        documentNumber: `IT-duplicate-${testClerkId}`,
      },
    );
    assert.equal(duplicateClient.status, 201);
    const duplicateDocument = await request<{ error: string }>(
      "/clients",
      "POST",
      {
        fullName: "Documento duplicado novamente",
        phone1: "11777770000",
        documentType: "OUTRO",
        documentNumber: `IT-duplicate-${testClerkId}`,
      },
    );
    assert.equal(duplicateDocument.status, 409);

    const loanInput = {
      clientId: clientResult.body.id,
      netAmount: 100,
      interestRate: 10,
      lateInterestRate: 1,
      installmentCount: 3,
      term: "3 dias",
      frequency: "DIARIA",
      paymentDay: null,
      loanDate: dateOffset(-5),
      firstDueDate: dateOffset(-2),
      notes: "Cenário automatizado isolado",
    };
    const createdLoan = await request<{ id: string; code: string; totalAmount: number }>(
      "/loans",
      "POST",
      loanInput,
    );
    assert.equal(createdLoan.status, 201);
    assert.equal(createdLoan.body.totalAmount, 110);
    assert.match(createdLoan.body.code, /^PR-\d{4}-\d{6}$/);

    const loanDetail = await request<{
      loan: { id: string; balance: number; status: string };
      installments: Array<{ id: string; number: number; scheduledAmount: number }>;
      payments: Array<{ id: string; lateAmount: number; totalAmount: number }>;
    }>(`/loans/${createdLoan.body.id}`);
    assert.equal(loanDetail.status, 200);
    assert.equal(loanDetail.body.installments.length, 3);
    assert.equal(
      Math.round(
        loanDetail.body.installments.reduce(
          (sum, installment) => sum + installment.scheduledAmount,
          0,
        ) * 100,
      ),
      11_000,
    );

    const partialPayment = {
      installmentId: loanDetail.body.installments[0]!.id,
      principalAmount: 10,
      method: "PIX",
      idempotencyKey: randomUUID(),
      paidAt: new Date().toISOString(),
      notes: "Abono parcial de teste",
    };
    const firstPayment = await request<{
      id: string;
      lateAmount: number;
      totalAmount: number;
    }>(`/loans/${createdLoan.body.id}/payments`, "POST", partialPayment);
    assert.equal(firstPayment.status, 201);
    assert.ok(firstPayment.body.lateAmount > 0);
    assert.ok(firstPayment.body.totalAmount > partialPayment.principalAmount);

    const duplicatePayment = await request<{ id: string }>(
      `/loans/${createdLoan.body.id}/payments`,
      "POST",
      partialPayment,
    );
    assert.equal(duplicatePayment.status, 201);
    assert.equal(duplicatePayment.body.id, firstPayment.body.id);

    const overpayment = await request<{ error: string }>(
      `/loans/${createdLoan.body.id}/payments`,
      "POST",
      {
        ...partialPayment,
        idempotencyKey: randomUUID(),
        principalAmount: 100_000,
      },
    );
    assert.equal(overpayment.status, 409);
    const negativePayment = await request<{ error: string }>(
      `/loans/${createdLoan.body.id}/payments`,
      "POST",
      {
        ...partialPayment,
        idempotencyKey: randomUUID(),
        principalAmount: -1,
      },
    );
    assert.equal(negativePayment.status, 400);

    const secondInput = {
      ...loanInput,
      netAmount: 40,
      interestRate: 0,
      installmentCount: 2,
      term: "2 semanas",
      frequency: "SEMANAL",
      loanDate: dateOffset(0),
      firstDueDate: dateOffset(1),
      notes: "Segundo contrato independente",
    };
    const secondLoan = await request<{ id: string; code: string; status: string }>(
      "/loans",
      "POST",
      secondInput,
    );
    assert.equal(secondLoan.status, 201);
    assert.notEqual(secondLoan.body.id, createdLoan.body.id);
    assert.notEqual(secondLoan.body.code, createdLoan.body.code);

    const wrongLoanPayment = await request<{ error: string }>(
      `/loans/${secondLoan.body.id}/payments`,
      "POST",
      {
        ...partialPayment,
        idempotencyKey: randomUUID(),
        principalAmount: 1,
      },
    );
    assert.equal(wrongLoanPayment.status, 409);

    const history = await request<{
      client: { id: string };
      loans: Array<{ id: string; code: string; status: string; balance: number }>;
    }>(`/clients/${clientResult.body.id}/history`);
    assert.equal(history.status, 200);
    assert.equal(history.body.loans.length, 2);
    assert.ok(history.body.loans.some((loan) => loan.id === createdLoan.body.id));
    assert.ok(history.body.loans.some((loan) => loan.id === secondLoan.body.id));

    let currentDetail = await request<{
      loan: { balance: number; status: string };
      installments: Array<{ id: string; balance: number }>;
      payments: Array<{ id: string }>;
    }>(`/loans/${createdLoan.body.id}`);
    assert.equal(currentDetail.body.loan.balance, 100);
    assert.equal(currentDetail.body.payments.length, 1);

    let paymentIndex = 0;
    for (const installment of currentDetail.body.installments) {
      if (installment.balance <= 0) continue;
      const payment = await request<{ id: string }>(
        `/loans/${createdLoan.body.id}/payments`,
        "POST",
        {
          installmentId: installment.id,
          principalAmount: installment.balance,
          method: "EFETIVO",
          idempotencyKey: randomUUID(),
          paidAt: new Date().toISOString(),
          notes: `Liquidação automatizada ${++paymentIndex}`,
        },
      );
      assert.equal(payment.status, 201);
    }

    const liquidatedLoan = await request<{
      loan: { status: string; balance: number };
      payments: Array<{ id: string }>;
    }>(`/loans/${createdLoan.body.id}`);
    assert.equal(liquidatedLoan.body.loan.status, "LIQUIDADO");
    assert.equal(liquidatedLoan.body.loan.balance, 0);
    assert.equal(liquidatedLoan.body.payments.length, 4);

    const invalidLoan = await request<{ error: string }>(
      "/loans",
      "POST",
      { ...loanInput, clientId: randomUUID() },
    );
    assert.equal(invalidLoan.status, 404);
    const persistedLoans = await db.select().from(testDb.loansTable);
    assert.equal(persistedLoans.length, 2);

    const auditRows = await db.select().from(testDb.auditEventsTable);
    assert.ok(auditRows.some((event) => event.action === "CREATE" && event.entity === "CLIENT"));
    assert.ok(auditRows.some((event) => event.action === "REGISTER_PAYMENT"));
    assert.ok(auditRows.some((event) => event.action === "LIQUIDATE"));

    await stopTestApi();
    await startTestApi();
    const afterReload = await request<{
      loan: { id: string; status: string };
      payments: Array<{ id: string }>;
    }>(`/loans/${createdLoan.body.id}`);
    assert.equal(afterReload.status, 200);
    assert.equal(afterReload.body.loan.status, "LIQUIDADO");
    assert.equal(afterReload.body.payments.length, 4);

    const secondLoanStillExists = await request<{ loan: { id: string; status: string } }>(
      `/loans/${secondLoan.body.id}`,
    );
    assert.equal(secondLoanStillExists.status, 200);
    assert.equal(secondLoanStillExists.body.loan.id, secondLoan.body.id);
    assert.equal(secondLoanStillExists.body.loan.status, "ATIVO");
  },
);
