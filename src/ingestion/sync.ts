import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { ensureFreshToken } from "../auth/token.js";
import { INITIAL_SYNC_BATCH } from "../config/constants.js";
import { query } from "../db/client.js";
import { logger as defaultLogger } from "../logger.js";
import { providerFor } from "../providers/index.js";
import type { NormalizedEmail } from "../providers/types.js";
import { upsertEmailVectors } from "../vector/pinecone.js";
import { buildEmbeddingText, contentHash } from "./chunker.js";
import { getExistingLog, recordLog } from "./dedup.js";
import { embedBatch } from "./embedder.js";
import { incrementIndexedCount, remainingQuota } from "./quota.js";

interface AccountRow {
  id: string;
  user_id: string;
  provider: "gmail" | "outlook" | "imap";
  email_address: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  last_synced: string | null;
  initial_sync_complete: boolean;
}

export async function syncAccount(
  accountId: string,
  log: Logger = defaultLogger,
): Promise<{ synced: number }> {
  const [acct] = await query<AccountRow>("SELECT * FROM accounts WHERE id = $1 AND is_active = true", [
    accountId,
  ]);
  if (!acct) throw new Error("account_not_found");

  const provider = providerFor(acct.provider);
  const accessToken = await ensureFreshToken(acct);

  const since = acct.last_synced ? new Date(acct.last_synced) : undefined;
  let pageToken: string | undefined;
  let totalSynced = 0;
  let page = 0;

  do {
    const quotaLeft = await remainingQuota(acct.user_id);
    if (quotaLeft <= 0) {
      log.warn({ accountId }, "quota exhausted — stopping sync");
      break;
    }

    const result = await provider.fetchPage(accessToken, {
      since,
      limit: Math.min(INITIAL_SYNC_BATCH, quotaLeft),
      pageToken,
    });

    const processed = await processBatch(acct, result.emails.slice(0, quotaLeft), log);
    totalSynced += processed;
    pageToken = result.nextPageToken;
    page++;
    log.debug({ page, processed, totalSynced, hasMore: !!pageToken }, "batch processed");
  } while (pageToken);

  await query("UPDATE accounts SET last_synced = now(), initial_sync_complete = true WHERE id = $1", [
    accountId,
  ]);

  return { synced: totalSynced };
}

async function processBatch(acct: AccountRow, emails: NormalizedEmail[], log: Logger): Promise<number> {
  if (emails.length === 0) return 0;

  const existing = await getExistingLog(
    acct.id,
    emails.map((e) => e.messageId),
  );
  const toEmbed: { email: NormalizedEmail; hash: string; vectorId: string; isNew: boolean }[] = [];

  for (const email of emails) {
    const hash = contentHash(email);
    const prior = existing.get(email.messageId);
    if (prior && prior.content_hash === hash) continue;
    toEmbed.push({
      email,
      hash,
      vectorId: prior?.vector_id ?? randomUUID(),
      isNew: !prior,
    });
  }

  if (toEmbed.length === 0) return 0;

  const vectors = await embedBatch(toEmbed.map((t) => buildEmbeddingText(t.email)));

  await upsertEmailVectors(
    acct.user_id,
    toEmbed.map((t, i) => ({
      id: t.vectorId,
      values: vectors[i]!,
      metadata: {
        user_id: acct.user_id,
        account_id: acct.id,
        message_id: t.email.messageId,
        thread_id: t.email.threadId,
        sender_email: t.email.senderEmail,
        sender_name: t.email.senderName,
        recipients: t.email.recipients,
        subject: t.email.subject,
        date: t.email.date,
        provider: acct.provider,
        has_attachments: t.email.hasAttachments,
        labels: t.email.labels,
      },
    })),
  );

  await recordLog(
    acct.id,
    toEmbed.map((t) => ({ message_id: t.email.messageId, content_hash: t.hash, vector_id: t.vectorId })),
  );

  const newlyAdded = toEmbed.filter((t) => t.isNew).length;
  await incrementIndexedCount(acct.user_id, newlyAdded);
  log.debug(
    { embedded: toEmbed.length, newlyAdded, skipped: emails.length - toEmbed.length },
    "batch embedded",
  );
  return toEmbed.length;
}
