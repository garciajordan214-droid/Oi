import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const clientStatusEnum = pgEnum("client_status", ["ATIVO", "INATIVO"]);
export const loanStatusEnum = pgEnum("loan_status", [
  "ATIVO",
  "EN_ATRASO",
  "LIQUIDADO",
  "CANCELADO",
]);
export const installmentStatusEnum = pgEnum("installment_status", [
  "PENDENTE",
  "PAGADA",
  "PARCIAL",
  "ATRASADA",
  "CANCELADA",
]);
export const paymentMethodEnum = pgEnum("payment_method", [
  "EFETIVO",
  "PIX",
  "TRANSFERENCIA",
  "OTRO",
]);
export const paymentFrequencyEnum = pgEnum("payment_frequency", [
  "DIARIA",
  "SEMANAL",
  "QUINCENAL",
  "MENSUAL",
]);
export const appRoleEnum = pgEnum("app_role", ["ADMIN", "COBRADOR"]);
export const userStatusEnum = pgEnum("user_status", ["ATIVO", "INATIVO"]);

export const appUsersTable = pgTable(
  "app_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    role: appRoleEnum("role").notNull().default("COBRADOR"),
    status: userStatusEnum("status").notNull().default("ATIVO"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("app_users_role_status_idx").on(table.role, table.status)],
);

export const clientsTable = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeNumber: serial("code_number").notNull().unique(),
    code: text("code").notNull().unique(),
    fullName: text("full_name").notNull(),
    phone1: text("phone1").notNull(),
    phone2: text("phone2"),
    whatsapp: text("whatsapp"),
    documentType: text("document_type"),
    documentNumber: text("document_number"),
    referencePoint: text("reference_point"),
    route: text("route"),
    status: clientStatusEnum("status").notNull().default("ATIVO"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("clients_document_number_unique")
      .on(table.documentNumber)
      .where(sql`${table.documentNumber} IS NOT NULL`),
    index("clients_name_idx").on(table.fullName),
    index("clients_status_idx").on(table.status),
  ],
);

export const loansTable = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeNumber: serial("code_number").notNull().unique(),
    code: text("code").notNull().unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "restrict" }),
    netAmount: numeric("net_amount", { precision: 14, scale: 2, mode: "number" })
      .notNull(),
    interestRate: numeric("interest_rate", {
      precision: 9,
      scale: 4,
      mode: "number",
    }).notNull(),
    lateInterestRate: numeric("late_interest_rate", {
      precision: 9,
      scale: 4,
      mode: "number",
    }).notNull(),
    installmentCount: integer("installment_count").notNull(),
    term: text("term").notNull(),
    frequency: paymentFrequencyEnum("frequency").notNull(),
    paymentDay: integer("payment_day"),
    totalAmount: numeric("total_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    installmentAmount: numeric("installment_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    loanDate: date("loan_date", { mode: "string" }).notNull(),
    firstDueDate: date("first_due_date", { mode: "string" }).notNull(),
    status: loanStatusEnum("status").notNull().default("ATIVO"),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => appUsersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("loans_client_id_idx").on(table.clientId),
    index("loans_status_idx").on(table.status),
  ],
);

export const installmentsTable = pgTable(
  "installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loansTable.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    scheduledAmount: numeric("scheduled_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    paidAmount: numeric("paid_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    balance: numeric("balance", { precision: 14, scale: 2, mode: "number" })
      .notNull(),
    status: installmentStatusEnum("status").notNull().default("PENDENTE"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("installments_loan_number_unique").on(table.loanId, table.number),
    index("installments_due_date_status_idx").on(table.dueDate, table.status),
  ],
);

export const paymentsTable = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeNumber: serial("code_number").notNull().unique(),
    code: text("code").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "restrict" }),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loansTable.id, { onDelete: "restrict" }),
    installmentId: uuid("installment_id")
      .notNull()
      .references(() => installmentsTable.id, { onDelete: "restrict" }),
    totalAmount: numeric("total_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    principalAmount: numeric("principal_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    lateAmount: numeric("late_amount", {
      precision: 14,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    method: paymentMethodEnum("method").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    registeredBy: uuid("registered_by")
      .notNull()
      .references(() => appUsersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payments_loan_id_idx").on(table.loanId),
    index("payments_client_id_idx").on(table.clientId),
    index("payments_paid_at_idx").on(table.paidAt),
  ],
);

export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsersTable.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    beforeData: jsonb("before_data").$type<Record<string, unknown> | null>(),
    afterData: jsonb("after_data").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_entity_idx").on(table.entity, table.entityId),
    index("audit_events_created_at_idx").on(table.createdAt),
  ],
);
