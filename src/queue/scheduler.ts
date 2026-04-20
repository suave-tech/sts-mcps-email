import { POLL_INTERVAL_MS } from "../config/constants.js";
import { query } from "../db/client.js";
import { logger } from "../logger.js";
import { syncQueue } from "./queue.js";

async function enqueueDueAccounts(): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM accounts
     WHERE is_active = true AND needs_reauth = false
       AND (last_synced IS NULL OR last_synced < now() - interval '60 minutes')`,
  );
  for (const row of rows) {
    await syncQueue.add(
      "incremental",
      { accountId: row.id, kind: "incremental" },
      { jobId: `incr:${row.id}:${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 },
    );
  }
  logger.info({ enqueued: rows.length }, "scheduler tick");
}

async function tick(): Promise<void> {
  try {
    await enqueueDueAccounts();
  } catch (err) {
    logger.error({ err }, "scheduler tick failed");
  }
}

tick();
setInterval(tick, POLL_INTERVAL_MS);
logger.info({ intervalMinutes: POLL_INTERVAL_MS / 60000 }, "scheduler started");
