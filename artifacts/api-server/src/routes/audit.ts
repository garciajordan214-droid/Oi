import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  ListAuditEventsQueryParams,
  ListAuditEventsResponse,
} from "@workspace/api-zod";
import { auditEventsTable } from "@workspace/db";
import { findActiveAppUser, userRequired } from "../lib/auth";
import { db } from "@workspace/db";

const router: IRouter = Router();

router.get("/audit", async (req, res): Promise<void> => {
  const user = await findActiveAppUser(req.clerkUserId);
  if (!user) {
    userRequired(res);
    return;
  }
  if (user.role !== "ADMIN") {
    res.status(403).json({ error: "Apenas administradores podem consultar a auditoria." });
    return;
  }
  const params = ListAuditEventsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const events = await db
    .select()
    .from(auditEventsTable)
    .where(
      user.role === "ADMIN" ? undefined : eq(auditEventsTable.userId, user.id),
    )
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(params.data.limit ?? 50);
  res.json(ListAuditEventsResponse.parse(events));
});

export default router;
