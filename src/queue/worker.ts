import { Worker } from "bullmq";
import { query } from "../db/client.js";
import { syncAccount } from "../ingestion/sync.js";
import { logger } from "../logger.js";
import { metrics } from "../metrics.js";
import { type SyncJobPayload, connection } from "./queue.js";

export const worker = new Worker<SyncJobPayload>(
  "email-sync",
  async (job) => {
    const log = logger.child({ jobId: job.id, accountId: job.data.accountId, kind: job.data.kind });
    metrics.syncJobsStarted.inc();
    log.info("sync started");

    const [syncJob] = await query<{ id: string }>(
      `INSERT INTO sync_jobs (account_id, status, started_at) VALUES ($1, 'running', now()) RETURNING id`,
      [job.data.accountId],
    );

    try {
      const { synced } = await syncAccount(job.data.accountId, log);
      await query(
        `UPDATE sync_jobs SET status = 'complete', completed_at = now(), emails_synced = $1 WHERE id = $2`,
        [synced, syncJob!.id],
      );
      metrics.syncJobsCompleted.inc();
      metrics.emailsIndexed.inc(synced);
      log.info({ synced }, "sync complete");
      return { synced };
    } catch (err) {
      await query(`UPDATE sync_jobs SET status = 'failed', completed_at = now(), error = $1 WHERE id = $2`, [
        String((err as Error).message),
        syncJob!.id,
      ]);
      metrics.syncJobsFailed.inc();
      log.error({ err }, "sync failed");
      throw err;
    }
  },
  { connection, concurrency: 4 },
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "bullmq job failed");
});

logger.info("worker listening on queue 'email-sync'");
