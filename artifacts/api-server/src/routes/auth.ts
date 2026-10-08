import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  SyncCurrentUserBody,
  SyncCurrentUserResponse,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import { appUsersTable, db } from "@workspace/db";

const router: IRouter = Router();

router.get("/me", async (req, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.clerkUserId, req.clerkUserId ?? ""))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "Perfil ainda não sincronizado." });
    return;
  }
  res.json(GetCurrentUserResponse.parse(user));
});

router.post("/me", async (req, res): Promise<void> => {
  const parsed = SyncCurrentUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const clerkUserId = req.clerkUserId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Autenticação necessária." });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.clerkUserId, clerkUserId))
      .limit(1);
    if (existing) {
      if (existing.status !== "ATIVO") {
        res.status(403).json({ error: "Usuário inativo." });
        return;
      }
      const [updated] = await db
        .update(appUsersTable)
        .set({ name: parsed.data.name, email: parsed.data.email })
        .where(eq(appUsersTable.id, existing.id))
        .returning();
      res.json(SyncCurrentUserResponse.parse(updated));
      return;
    }

    const [created] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(741852963)`);
      const [alreadyRegistered] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .limit(1);
      const [newUser] = await tx
        .insert(appUsersTable)
        .values({
          clerkUserId,
          name: parsed.data.name,
          email: parsed.data.email.toLowerCase(),
          role: alreadyRegistered ? "COBRADOR" : "ADMIN",
        })
        .returning();
      return [newUser] as const;
    });
    res.status(200).json(SyncCurrentUserResponse.parse(created));
  } catch (error) {
    req.log.warn({ err: error }, "User profile could not be synchronized");
    res.status(409).json({
      error: "Não foi possível sincronizar o perfil. Verifique o e-mail cadastrado.",
    });
  }
});

export default router;
