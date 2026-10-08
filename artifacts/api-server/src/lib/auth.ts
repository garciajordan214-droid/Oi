import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db, appUsersTable } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      clerkUserId?: string;
    }
  }
}

export function requireClerkIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Autenticação necessária." });
    return;
  }
  req.clerkUserId = userId;
  next();
}

export async function findActiveAppUser(
  clerkUserId: string | undefined,
): Promise<typeof appUsersTable.$inferSelect | null> {
  if (!clerkUserId) return null;
  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(
      and(
        eq(appUsersTable.clerkUserId, clerkUserId),
        eq(appUsersTable.status, "ATIVO"),
      ),
    )
    .limit(1);
  return user ?? null;
}

export function userRequired(res: Response): void {
  res.status(403).json({
    error: "Perfil não sincronizado ou usuário inativo. Verifique seu acesso.",
  });
}
