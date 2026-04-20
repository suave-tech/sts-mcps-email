import { Router } from "express";
import { type AuthedRequest, requireAuth } from "../auth/jwt.js";

// NOTE: routes that use `req.params` narrow Express's Request generic, which
// makes a direct `req as AuthedRequest` cast fail the "sufficient overlap"
// check. We double-cast through `unknown` — requireAuth middleware guarantees
// userId is set by the time these handlers run.
import { query } from "../db/client.js";
import { syncQueue } from "../queue/queue.js";
import { deleteByAccount } from "../vector/pinecone.js";

export const accountsRouter: Router = Router();

accountsRouter.use(requireAuth);

accountsRouter.get("/", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  const rows = await query(
    `SELECT id, provider, email_address, last_synced, initial_sync_complete, is_active, needs_reauth
     FROM accounts WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  res.json({ accounts: rows });
});

accountsRouter.delete("/:accountId", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  const { accountId } = req.params;
  const rows = await query<{ id: string }>("SELECT id FROM accounts WHERE id = $1 AND user_id = $2", [
    accountId,
    userId,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await deleteByAccount(userId, accountId!);
  await query("DELETE FROM accounts WHERE id = $1", [accountId]);
  res.json({ deleted: true });
});

accountsRouter.get("/:accountId/sync", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  const rows = await query(
    `SELECT id, status, emails_synced, started_at, completed_at, error
     FROM sync_jobs WHERE account_id IN
       (SELECT id FROM accounts WHERE id = $1 AND user_id = $2)
     ORDER BY started_at DESC NULLS LAST LIMIT 10`,
    [req.params.accountId, userId],
  );
  res.json({ jobs: rows });
});

accountsRouter.post("/:accountId/sync", async (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  const rows = await query<{ id: string }>("SELECT id FROM accounts WHERE id = $1 AND user_id = $2", [
    req.params.accountId,
    userId,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const job = await syncQueue.add("manual", { accountId: rows[0]!.id, kind: "incremental" });
  res.json({ queued: true, jobId: job.id });
});
