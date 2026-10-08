import { Router, type IRouter } from "express";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  ChangeLoanStatusBody,
  ChangeLoanStatusParams,
  ChangeLoanStatusResponse,
  CreateClientBody,
  CreateClientResponse,
  CreateLoanBody,
  CreateLoanResponse,
  GetDashboardResponse,
  GetClientHistoryParams,
  GetClientHistoryResponse,
  GetClientParams,
  GetClientResponse,
  GetLoanParams,
  GetLoanResponse,
  ListClientsQueryParams,
  ListClientsResponse,
  ListLoansQueryParams,
  ListLoansResponse,
  ListLoansResponseItem,
  RegisterPaymentParams,
  RegisterPaymentBody,
  RegisterPaymentResponse,
  UpdateClientBody,
  UpdateClientParams,
  UpdateClientResponse,
} from "@workspace/api-zod";
import {
  appUsersTable,
  clientsTable,
  db,
  installmentsTable,
  loansTable,
  paymentsTable,
} from "@workspace/db";
import { findActiveAppUser, userRequired } from "../lib/auth";
import { insertAudit } from "../lib/audit";

const router: IRouter = Router();
const cents = (amount: number): number => Math.round(amount * 100);
const money = (amountCents: number): number =>
  Number((amountCents / 100).toFixed(2));
const utcDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const dateAtSaoPaulo = (value: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
const dateOnly = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value;
const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.floor((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000));

function addMonth(dateValue: string, day: number): string {
  const date = utcDate(dateValue);
  const targetYear = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() + 1;
  const monthEnd = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(targetYear, targetMonth, Math.min(day, monthEnd)),
  )
    .toISOString()
    .slice(0, 10);
}

function nextDueDate(
  current: string,
  frequency: string,
  paymentDay: number | null,
): string {
  if (frequency === "DIARIA") {
    return new Date(utcDate(current).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  if (frequency === "SEMANAL" || frequency === "QUINCENAL") {
    const days = frequency === "SEMANAL" ? 7 : 14;
    return new Date(utcDate(current).getTime() + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  const day = paymentDay ?? utcDate(current).getUTCDate();
  return addMonth(current, day);
}

function clientCode(number: number): string {
  return `CL-${String(number).padStart(6, "0")}`;
}

function loanCode(year: string, number: number): string {
  return `PR-${year}-${String(number).padStart(6, "0")}`;
}

function paymentCode(year: string, number: number): string {
  return `AB-${year}-${String(number).padStart(6, "0")}`;
}

function clientSnapshot(client: typeof clientsTable.$inferSelect) {
  return {
    id: client.id,
    code: client.code,
    fullName: client.fullName,
    phone1: client.phone1,
    phone2: client.phone2,
    whatsapp: client.whatsapp,
    documentType: client.documentType,
    documentNumber: client.documentNumber,
    referencePoint: client.referencePoint,
    route: client.route,
    status: client.status,
    notes: client.notes,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

function loanSnapshot(loan: typeof loansTable.$inferSelect) {
  return {
    id: loan.id,
    code: loan.code,
    clientId: loan.clientId,
    netAmount: loan.netAmount,
    interestRate: loan.interestRate,
    lateInterestRate: loan.lateInterestRate,
    installmentCount: loan.installmentCount,
    term: loan.term,
    frequency: loan.frequency,
    paymentDay: loan.paymentDay,
    totalAmount: loan.totalAmount,
    installmentAmount: loan.installmentAmount,
    loanDate: loan.loanDate,
    firstDueDate: loan.firstDueDate,
    status: loan.status,
    notes: loan.notes,
    createdAt: loan.createdAt,
    updatedAt: loan.updatedAt,
  };
}

function installmentSnapshot(installment: typeof installmentsTable.$inferSelect) {
  return {
    id: installment.id,
    loanId: installment.loanId,
    number: installment.number,
    dueDate: installment.dueDate,
    scheduledAmount: installment.scheduledAmount,
    paidAmount: installment.paidAmount,
    balance: installment.balance,
    status: installment.status,
    paidAt: installment.paidAt,
    notes: installment.notes,
  };
}

function paymentSnapshot(payment: typeof paymentsTable.$inferSelect) {
  return {
    id: payment.id,
    code: payment.code,
    clientId: payment.clientId,
    loanId: payment.loanId,
    installmentId: payment.installmentId,
    totalAmount: payment.totalAmount,
    principalAmount: payment.principalAmount,
    lateAmount: payment.lateAmount,
    method: payment.method,
    paidAt: payment.paidAt,
    notes: payment.notes,
    registeredBy: payment.registeredBy,
    createdAt: payment.createdAt,
  };
}

async function activeUser(
  req: import("express").Request,
  res: import("express").Response,
) {
  const user = await findActiveAppUser(req.clerkUserId);
  if (!user) {
    userRequired(res);
    return null;
  }
  return user;
}

async function refreshLoanStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  loanId: string,
  userId: string,
) {
  const [loan] = await tx
    .select()
    .from(loansTable)
    .where(eq(loansTable.id, loanId))
    .for("update");
  if (!loan || loan.status === "CANCELADO" || loan.status === "LIQUIDADO") {
    return loan;
  }
  const installments = await tx
    .select()
    .from(installmentsTable)
    .where(eq(installmentsTable.loanId, loanId));
  const today = dateAtSaoPaulo(new Date());
  for (const installment of installments) {
    if (cents(installment.balance) <= 0) continue;
    const overdue = installment.dueDate < today;
    const nextStatus = overdue
      ? "ATRASADA"
      : installment.status === "ATRASADA"
        ? "PARCIAL"
        : installment.status;
    if (nextStatus !== installment.status) {
      await tx
        .update(installmentsTable)
        .set({ status: nextStatus })
        .where(eq(installmentsTable.id, installment.id));
      await insertAudit(tx, {
        userId,
        action: "CHANGE_STATUS_AUTOMATIC",
        entity: "INSTALLMENT",
        entityId: installment.id,
        beforeData: { status: installment.status },
        afterData: { status: nextStatus },
      });
    }
  }

  const hasOverdue = installments.some(
    (item) => cents(item.balance) > 0 && item.dueDate < today,
  );
  const outstandingCents = installments.reduce(
    (sum, item) => sum + cents(item.balance),
    0,
  );
  const nextLoanStatus =
    outstandingCents === 0 ? "LIQUIDADO" : hasOverdue ? "EN_ATRASO" : "ATIVO";
  if (loan.status !== nextLoanStatus) {
    const [updated] = await tx
      .update(loansTable)
      .set({ status: nextLoanStatus })
      .where(eq(loansTable.id, loanId))
      .returning();
    await insertAudit(tx, {
      userId,
      action: nextLoanStatus === "LIQUIDADO" ? "LIQUIDATE" : "CHANGE_STATUS_AUTOMATIC",
      entity: "LOAN",
      entityId: loanId,
      beforeData: { status: loan.status },
      afterData: { status: nextLoanStatus },
    });
    return updated;
  }
  return loan;
}

async function summariesForLoans(
  loans: (typeof loansTable.$inferSelect)[],
): Promise<ReturnType<typeof ListLoansResponseItem.parse>[]> {
  if (!loans.length) return [];
  const ids = loans.map((loan) => loan.id);
  const clientIds = [...new Set(loans.map((loan) => loan.clientId))];
  const [clientRows, installmentRows, paymentRows] = await Promise.all([
    db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    db
      .select()
      .from(installmentsTable)
      .where(inArray(installmentsTable.loanId, ids)),
    db.select().from(paymentsTable).where(inArray(paymentsTable.loanId, ids)),
  ]);
  const names = new Map(clientRows.map((item) => [item.id, item.fullName]));
  return loans.map((loan) => {
    const installments = installmentRows.filter((item) => item.loanId === loan.id);
    const payments = paymentRows.filter((item) => item.loanId === loan.id);
    const paidInstallments = installments.filter((item) => item.status === "PAGADA").length;
    const pendingInstallments = installments.filter(
      (item) => item.balance > 0 && item.status !== "CANCELADA",
    ).length;
    const paidCents = payments.reduce((sum, item) => sum + cents(item.totalAmount), 0);
    const balanceCents = installments.reduce((sum, item) => sum + cents(item.balance), 0);
    return ListLoansResponseItem.parse({
      ...loanSnapshot(loan),
      clientName: names.get(loan.clientId) ?? "Cliente",
      paidInstallments,
      pendingInstallments,
      paidAmount: money(paidCents),
      balance: money(balanceCents),
    });
  });
}

router.get("/dashboard", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;

  const allActiveLoans = await db
    .select()
    .from(loansTable)
    .where(inArray(loansTable.status, ["ATIVO", "EN_ATRASO"]));
  for (const loan of allActiveLoans) {
    await db.transaction((tx) => refreshLoanStatus(tx, loan.id, user.id));
  }
  const [activeClients, loans, paymentRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(clientsTable)
      .where(eq(clientsTable.status, "ATIVO")),
    db
      .select()
      .from(loansTable)
      .where(inArray(loansTable.status, ["ATIVO", "EN_ATRASO"])),
    db
      .select()
      .from(paymentsTable)
      .orderBy(desc(paymentsTable.paidAt))
      .limit(100),
  ]);
  const today = new Date();
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  const currentMonthPayments = paymentRows.filter(
    (payment) => payment.paidAt >= monthStart,
  );
  const summaries = await summariesForLoans(loans);
  res.json(
    GetDashboardResponse.parse({
      activeClients: activeClients[0]?.count ?? 0,
      activeLoans: loans.length,
      overdueLoans: loans.filter((loan) => loan.status === "EN_ATRASO").length,
      totalReceivable: money(
        summaries.reduce((sum, loan) => sum + cents(loan.balance), 0),
      ),
      receivedThisMonth: money(
        currentMonthPayments.reduce(
          (sum, payment) => sum + cents(payment.totalAmount),
          0,
        ),
      ),
      recentPayments: paymentRows.slice(0, 8).map(paymentSnapshot),
    }),
  );
});

router.get("/clients", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const parsed = ListClientsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conditions = [];
  if (parsed.data.status) conditions.push(eq(clientsTable.status, parsed.data.status));
  if (parsed.data.search?.trim()) {
    const search = `%${parsed.data.search.trim()}%`;
    conditions.push(
      or(
        ilike(clientsTable.fullName, search),
        ilike(clientsTable.phone1, search),
        ilike(clientsTable.code, search),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(clientsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(clientsTable.fullName))
    .limit(250);
  res.json(ListClientsResponse.parse(rows.map(clientSnapshot)));
});

router.post("/clients", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const id = crypto.randomUUID();
  try {
    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(clientsTable)
        .values({
          id,
          code: `pending-${id}`,
          fullName: parsed.data.fullName.trim(),
          phone1: parsed.data.phone1.trim(),
          phone2: parsed.data.phone2 || null,
          whatsapp: parsed.data.whatsapp || null,
          documentType: parsed.data.documentType || null,
          documentNumber: parsed.data.documentNumber || null,
          referencePoint: parsed.data.referencePoint || null,
          route: parsed.data.route || null,
          status: parsed.data.status ?? "ATIVO",
          notes: parsed.data.notes || null,
        })
        .returning();
      const code = clientCode(inserted.codeNumber);
      const [client] = await tx
        .update(clientsTable)
        .set({ code })
        .where(eq(clientsTable.id, inserted.id))
        .returning();
      await insertAudit(tx, {
        userId: user.id,
        action: "CREATE",
        entity: "CLIENT",
        entityId: client.id,
        afterData: clientSnapshot(client),
      });
      return client;
    });
    res.status(201).json(CreateClientResponse.parse(clientSnapshot(created)));
  } catch (error) {
    req.log.error({ err: error }, "Unable to create client");
    res.status(409).json({ error: "Não foi possível criar o cliente." });
  }
});

router.get("/clients/:id", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const params = GetClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, params.data.id))
    .limit(1);
  if (!client) {
    res.status(404).json({ error: "Cliente não encontrado." });
    return;
  }
  res.json(GetClientResponse.parse(clientSnapshot(client)));
});

router.patch("/clients/:id", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const params = UpdateClientParams.safeParse(req.params);
  const parsed = UpdateClientBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, params.data.id))
      .for("update");
    if (!before) return null;
    if (parsed.data.documentNumber) {
      const [duplicate] = await tx
        .select({ id: clientsTable.id })
        .from(clientsTable)
        .where(
          and(
            eq(clientsTable.documentNumber, parsed.data.documentNumber),
            ne(clientsTable.id, before.id),
          ),
        )
        .limit(1);
      if (duplicate) return { kind: "duplicate" as const };
    }
    const [after] = await tx
      .update(clientsTable)
      .set({
        ...parsed.data,
        fullName: parsed.data.fullName.trim(),
        phone1: parsed.data.phone1.trim(),
        updatedAt: new Date(),
      })
      .where(eq(clientsTable.id, params.data.id))
      .returning();
    await insertAudit(tx, {
      userId: user.id,
      action:
        before.status !== after.status ? "CHANGE_STATUS" : "UPDATE",
      entity: "CLIENT",
      entityId: after.id,
      beforeData: clientSnapshot(before),
      afterData: clientSnapshot(after),
    });
    return { kind: "ok" as const, client: after };
  });
  if (!updated) {
    res.status(404).json({ error: "Cliente não encontrado." });
    return;
  }
  if (updated.kind === "duplicate") {
    res.status(409).json({
      error: "Já existe um cliente com este documento.",
    });
    return;
  }
  res.json(UpdateClientResponse.parse(clientSnapshot(updated.client)));
});

router.get("/clients/:id/history", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const params = GetClientHistoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, params.data.id))
    .limit(1);
  if (!client) {
    res.status(404).json({ error: "Cliente não encontrado." });
    return;
  }
  const loans = await db
    .select()
    .from(loansTable)
    .where(eq(loansTable.clientId, client.id))
    .orderBy(desc(loansTable.loanDate));
  const summaries = await summariesForLoans(loans);
  res.json(
    GetClientHistoryResponse.parse({
      client: clientSnapshot(client),
      loans: summaries,
    }),
  );
});

router.get("/loans", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const parsed = ListLoansQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conditions = [];
  if (parsed.data.clientId) {
    conditions.push(eq(loansTable.clientId, parsed.data.clientId));
  }
  if (parsed.data.status) conditions.push(eq(loansTable.status, parsed.data.status));
  if (parsed.data.search?.trim()) {
    const search = `%${parsed.data.search.trim()}%`;
    const [matchingClients, matchingLoanIds] = await Promise.all([
      db
        .select({ id: clientsTable.id })
        .from(clientsTable)
        .where(ilike(clientsTable.fullName, search)),
      db
        .select({ id: loansTable.id })
        .from(loansTable)
        .where(ilike(loansTable.code, search)),
    ]);
    const matchingClientIds = matchingClients.map((row) => row.id);
    const matchingIds = matchingLoanIds.map((row) => row.id);
    if (!matchingClientIds.length && !matchingIds.length) {
      res.json([]);
      return;
    }
    conditions.push(
      or(
        matchingClientIds.length
          ? inArray(loansTable.clientId, matchingClientIds)
          : undefined,
        matchingIds.length ? inArray(loansTable.id, matchingIds) : undefined,
      )!,
    );
  }
  const rows = await db
    .select()
    .from(loansTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(loansTable.loanDate))
    .limit(500);
  for (const loan of rows) {
    await db.transaction((tx) => refreshLoanStatus(tx, loan.id, user.id));
  }
  const refreshed = rows.length
    ? await db
        .select()
        .from(loansTable)
        .where(inArray(loansTable.id, rows.map((row) => row.id)))
        .orderBy(desc(loansTable.loanDate))
    : [];
  res.json(ListLoansResponse.parse(await summariesForLoans(refreshed)));
});

router.post("/loans", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const parsed = CreateLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  const allowedFrequencies = ["DIARIA", "SEMANAL", "QUINCENAL", "MENSUAL"] as const;
  if (!allowedFrequencies.includes(input.frequency as (typeof allowedFrequencies)[number])) {
    res.status(400).json({ error: "Frequência de pagamento inválida." });
    return;
  }
  const loanDate = dateOnly(input.loanDate);
  const firstDueDate = dateOnly(input.firstDueDate);
  const principalCents = cents(input.netAmount);
  const totalCents = Math.round(
    principalCents * (1 + input.interestRate / 100),
  );
  if (
    principalCents <= 0 ||
    !Number.isSafeInteger(totalCents) ||
    totalCents < input.installmentCount
  ) {
    res.status(400).json({
      error: "O valor do empréstimo não permite gerar parcelas positivas.",
    });
    return;
  }
  if (
    Number.isNaN(utcDate(loanDate).getTime()) ||
    Number.isNaN(utcDate(firstDueDate).getTime()) ||
    firstDueDate < loanDate
  ) {
    res.status(400).json({
      error: "A primeira parcela deve ter uma data válida igual ou posterior ao empréstimo.",
    });
    return;
  }

  const id = crypto.randomUUID();
  try {
    const created = await db.transaction(async (tx) => {
      const [client] = await tx
        .select()
        .from(clientsTable)
        .where(eq(clientsTable.id, input.clientId))
        .limit(1);
      if (!client || client.status !== "ATIVO") return null;
      const [inserted] = await tx
        .insert(loansTable)
        .values({
          id,
          code: `pending-${id}`,
          clientId: client.id,
          netAmount: money(principalCents),
          interestRate: input.interestRate,
          lateInterestRate: input.lateInterestRate,
          installmentCount: input.installmentCount,
          term: input.term.trim(),
          frequency: input.frequency as "DIARIA" | "SEMANAL" | "QUINCENAL" | "MENSUAL",
          paymentDay: input.paymentDay ?? null,
          totalAmount: money(totalCents),
          installmentAmount: money(Math.floor(totalCents / input.installmentCount)),
          loanDate,
          firstDueDate,
          status: "ATIVO",
          notes: input.notes || null,
          createdBy: user.id,
        })
        .returning();
      const code = loanCode(loanDate.slice(0, 4), inserted.codeNumber);
      const [loan] = await tx
        .update(loansTable)
        .set({ code })
        .where(eq(loansTable.id, inserted.id))
        .returning();

      const installmentRows = [];
      let dueDate = firstDueDate;
      const baseCents = Math.floor(totalCents / input.installmentCount);
      let remainder = totalCents - baseCents * input.installmentCount;
      for (let number = 1; number <= input.installmentCount; number += 1) {
        const scheduledCents = baseCents + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        installmentRows.push({
          loanId: loan.id,
          number,
          dueDate,
          scheduledAmount: money(scheduledCents),
          paidAmount: 0,
          balance: money(scheduledCents),
          status: "PENDENTE" as const,
        });
        dueDate = nextDueDate(
          dueDate,
          input.frequency,
          input.paymentDay ?? null,
        );
      }
      await tx.insert(installmentsTable).values(installmentRows);
      await insertAudit(tx, {
        userId: user.id,
        action: "CREATE",
        entity: "LOAN",
        entityId: loan.id,
        afterData: loanSnapshot(loan),
      });
      return loan;
    });
    if (!created) {
      res.status(404).json({
        error: "Cliente não encontrado ou inativo. Não foi criado nenhum empréstimo.",
      });
      return;
    }
    res.status(201).json(CreateLoanResponse.parse(loanSnapshot(created)));
  } catch (error) {
    req.log.error({ err: error }, "Unable to create loan");
    res.status(409).json({
      error: "Não foi possível criar o empréstimo e suas parcelas.",
    });
  }
});

router.get("/loans/:id", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const params = GetLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [loan] = await db
    .select()
    .from(loansTable)
    .where(eq(loansTable.id, params.data.id))
    .limit(1);
  if (!loan) {
    res.status(404).json({ error: "Empréstimo não encontrado." });
    return;
  }
  if (loan.status !== "CANCELADO" && loan.status !== "LIQUIDADO") {
    await db.transaction((tx) => refreshLoanStatus(tx, loan.id, user.id));
  }
  const [freshLoan] = await db
    .select()
    .from(loansTable)
    .where(eq(loansTable.id, loan.id))
    .limit(1);
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, loan.clientId))
    .limit(1);
  const [summary] = await summariesForLoans(freshLoan ? [freshLoan] : []);
  const [installments, payments] = await Promise.all([
    db
      .select()
      .from(installmentsTable)
      .where(eq(installmentsTable.loanId, loan.id))
      .orderBy(asc(installmentsTable.number)),
    db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.loanId, loan.id))
      .orderBy(desc(paymentsTable.paidAt)),
  ]);
  res.json(
    GetLoanResponse.parse({
      loan: summary,
      clientName: client?.fullName ?? "Cliente",
      installments: installments.map(installmentSnapshot),
      payments: payments.map(paymentSnapshot),
    }),
  );
});

router.patch("/loans/:id/status", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const params = ChangeLoanStatusParams.safeParse(req.params);
  const parsed = ChangeLoanStatusBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [loan] = await tx
      .select()
      .from(loansTable)
      .where(eq(loansTable.id, params.data.id))
      .for("update");
    if (!loan) return { kind: "missing" as const };
    if (loan.status === "LIQUIDADO" || loan.status === "CANCELADO") {
      return { kind: "closed" as const };
    }
    if (parsed.data.status === "LIQUIDADO") {
      const [openBalance] = await tx
        .select({
          balance: sql<number>`coalesce(sum(${installmentsTable.balance}), 0)::float8`,
        })
        .from(installmentsTable)
        .where(eq(installmentsTable.loanId, loan.id));
      if (cents(openBalance?.balance ?? 0) > 0) {
        return { kind: "balance" as const };
      }
    }
    const [updated] = await tx
      .update(loansTable)
      .set({
        status: parsed.data.status,
        notes: parsed.data.notes ?? loan.notes,
        updatedAt: new Date(),
      })
      .where(eq(loansTable.id, loan.id))
      .returning();
    if (parsed.data.status === "CANCELADO") {
      const openInstallments = await tx
        .select()
        .from(installmentsTable)
        .where(
          and(
            eq(installmentsTable.loanId, loan.id),
            inArray(installmentsTable.status, [
              "PENDENTE",
              "PARCIAL",
              "ATRASADA",
            ]),
          ),
        );
      for (const installment of openInstallments) {
        const [cancelledInstallment] = await tx
          .update(installmentsTable)
          .set({ status: "CANCELADA", updatedAt: new Date() })
          .where(eq(installmentsTable.id, installment.id))
          .returning();
        await insertAudit(tx, {
          userId: user.id,
          action: "CHANGE_STATUS",
          entity: "INSTALLMENT",
          entityId: installment.id,
          beforeData: installmentSnapshot(installment),
          afterData: installmentSnapshot(cancelledInstallment),
        });
      }
    }
    await insertAudit(tx, {
      userId: user.id,
      action: parsed.data.status === "LIQUIDADO" ? "LIQUIDATE" : "CANCEL",
      entity: "LOAN",
      entityId: loan.id,
      beforeData: loanSnapshot(loan),
      afterData: loanSnapshot(updated),
    });
    return { kind: "ok" as const, loan: updated };
  });
  if (result.kind === "missing") {
    res.status(404).json({ error: "Empréstimo não encontrado." });
    return;
  }
  if (result.kind === "closed") {
    res.status(409).json({ error: "O empréstimo já está encerrado." });
    return;
  }
  if (result.kind === "balance") {
    res.status(409).json({
      error: "Não é possível liquidar um empréstimo com saldo em aberto.",
    });
    return;
  }
  res.json(ChangeLoanStatusResponse.parse(loanSnapshot(result.loan)));
});

router.post("/loans/:id/payments", async (req, res): Promise<void> => {
  const user = await activeUser(req, res);
  if (!user) return;
  const params = RegisterPaymentParams.safeParse(req.params);
  const parsed = RegisterPaymentBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const requestedCents = cents(parsed.data.principalAmount);
  if (requestedCents <= 0) {
    res.status(400).json({ error: "O valor do abono deve ser positivo." });
    return;
  }
  const paidAt = parsed.data.paidAt ?? new Date();
  if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 60_000) {
    res.status(400).json({ error: "A data do abono é inválida." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${parsed.data.idempotencyKey}))`,
    );
    const [duplicateRequest] = await tx
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.idempotencyKey, parsed.data.idempotencyKey))
      .limit(1);
    if (duplicateRequest) {
      return { kind: "ok" as const, payment: duplicateRequest };
    }
    const [loan] = await tx
      .select()
      .from(loansTable)
      .where(eq(loansTable.id, params.data.id))
      .for("update");
    if (!loan) return { kind: "missing" as const };
    if (loan.status === "CANCELADO" || loan.status === "LIQUIDADO") {
      return { kind: "closed" as const };
    }
    const [installment] = await tx
      .select()
      .from(installmentsTable)
      .where(eq(installmentsTable.id, parsed.data.installmentId))
      .for("update");
    if (!installment) return { kind: "installment-missing" as const };
    if (installment.loanId !== loan.id) {
      return { kind: "wrong-loan" as const };
    }
    if (requestedCents > cents(installment.balance)) {
      return { kind: "overpayment" as const };
    }
    const [client] = await tx
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, loan.clientId))
      .limit(1);
    if (!client) return { kind: "missing" as const };

    const overdueDays = daysBetween(
      installment.dueDate,
      dateAtSaoPaulo(paidAt),
    );
    const lateCents =
      overdueDays > 0
        ? Math.round(
            cents(installment.balance) *
              (loan.lateInterestRate / 100) *
              overdueDays,
          )
        : 0;
    const totalPaymentCents = requestedCents + lateCents;
    const paymentId = crypto.randomUUID();
    const [inserted] = await tx
      .insert(paymentsTable)
      .values({
        id: paymentId,
        code: `pending-${paymentId}`,
        idempotencyKey: parsed.data.idempotencyKey,
        clientId: client.id,
        loanId: loan.id,
        installmentId: installment.id,
        totalAmount: money(totalPaymentCents),
        principalAmount: money(requestedCents),
        lateAmount: money(lateCents),
        method: parsed.data.method,
        paidAt,
        notes: parsed.data.notes || null,
        registeredBy: user.id,
      })
      .returning();
    const code = paymentCode(dateAtSaoPaulo(paidAt).slice(0, 4), inserted.codeNumber);
    const [payment] = await tx
      .update(paymentsTable)
      .set({ code })
      .where(eq(paymentsTable.id, paymentId))
      .returning();
    const balanceCents = cents(installment.balance) - requestedCents;
    const paidAmountCents = cents(installment.paidAmount) + requestedCents;
    const installmentStatus =
      balanceCents === 0
        ? "PAGADA"
        : installment.dueDate < dateAtSaoPaulo(paidAt)
          ? "ATRASADA"
          : "PARCIAL";
    const [updatedInstallment] = await tx
      .update(installmentsTable)
      .set({
        paidAmount: money(paidAmountCents),
        balance: money(balanceCents),
        status: installmentStatus,
        paidAt: balanceCents === 0 ? paidAt : installment.paidAt,
        updatedAt: new Date(),
      })
      .where(eq(installmentsTable.id, installment.id))
      .returning();
    await insertAudit(tx, {
      userId: user.id,
      action: "REGISTER_PAYMENT",
      entity: "PAYMENT",
      entityId: payment.id,
      afterData: paymentSnapshot(payment),
    });
    await insertAudit(tx, {
      userId: user.id,
      action: "CHANGE_STATUS",
      entity: "INSTALLMENT",
      entityId: installment.id,
      beforeData: installmentSnapshot(installment),
      afterData: installmentSnapshot(updatedInstallment),
    });
    await refreshLoanStatus(tx, loan.id, user.id);
    return { kind: "ok" as const, payment };
  });
  if (result.kind === "missing" || result.kind === "installment-missing") {
    res.status(404).json({
      error:
        result.kind === "missing"
          ? "Empréstimo não encontrado."
          : "Parcela não encontrada.",
    });
    return;
  }
  if (result.kind === "closed") {
    res.status(409).json({ error: "Não é possível pagar um empréstimo encerrado." });
    return;
  }
  if (result.kind === "wrong-loan") {
    res.status(409).json({
      error: "A parcela informada não pertence a este empréstimo.",
    });
    return;
  }
  if (result.kind === "overpayment") {
    res.status(409).json({ error: "O abono excede o saldo da parcela." });
    return;
  }
  res.status(201).json(
    RegisterPaymentResponse.parse(paymentSnapshot(result.payment)),
  );
});

export default router;
