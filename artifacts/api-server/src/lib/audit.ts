import type { db } from "@workspace/db";
import { auditEventsTable } from "@workspace/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertAudit(
  tx: Transaction,
  event: {
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    beforeData?: Record<string, unknown> | null;
    afterData?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(auditEventsTable).values({
    ...event,
    beforeData: event.beforeData ?? null,
    afterData: event.afterData ?? null,
  });
}
