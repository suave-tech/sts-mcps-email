import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEmail } from "../src/providers/types.js";

// Integration test for the sync orchestrator. Every external boundary
// (Postgres, Pinecone, OpenAI embeddings, Gmail, token refresh) is swapped
// for an in-memory fake so we can assert on the full happy path, dedup
// behavior, and the quota cutoff without needing live services.
//
// The goal is to catch regressions where a refactor breaks the contract
// between sync.ts and the modules it orchestrates — the part the pure-logic
// unit tests can't see.

// ---------- in-memory state + mocks -------------------------------------

interface FakeDb {
  accounts: Map<string, Record<string, unknown>>;
  syncLog: Array<{ account_id: string; message_id: string; content_hash: string; vector_id: string }>;
  userQuota: Map<string, number>;
  updatedAccounts: string[];
}

const db: FakeDb = {
  accounts: new Map(),
  syncLog: [],
  userQuota: new Map(),
  updatedAccounts: [],
};

const upserts: Array<{ userId: string; count: number; ids: string[] }> = [];
const embedCalls: Array<{ count: number }> = [];

let providerEmails: NormalizedEmail[] = [];
let fetchPageCalls = 0;

vi.mock("../src/db/client.js", () => ({
  query: async (sql: string, params?: unknown[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT * FROM accounts")) {
      const acct = db.accounts.get(params![0] as string);
      return acct ? [acct] : [];
    }
    if (s.startsWith("SELECT message_id, content_hash, vector_id FROM sync_log")) {
      const [accountId, messageIds] = params as [string, string[]];
      return db.syncLog.filter((r) => r.account_id === accountId && messageIds.includes(r.message_id));
    }
    if (s.startsWith("INSERT INTO sync_log")) {
      const [accountId, messageId, vectorId, contentHash] = params as [string, string, string, string];
      const existing = db.syncLog.find((r) => r.account_id === accountId && r.message_id === messageId);
      if (existing) {
        existing.content_hash = contentHash;
        existing.vector_id = vectorId;
      } else {
        db.syncLog.push({
          account_id: accountId,
          message_id: messageId,
          vector_id: vectorId,
          content_hash: contentHash,
        });
      }
      return [];
    }
    if (s.startsWith("SELECT emails_indexed FROM user_quota")) {
      const userId = params![0] as string;
      const n = db.userQuota.get(userId);
      return n !== undefined ? [{ emails_indexed: n }] : [];
    }
    if (s.startsWith("INSERT INTO user_quota")) {
      const [userId, delta] = params as [string, number];
      db.userQuota.set(userId, (db.userQuota.get(userId) ?? 0) + delta);
      return [];
    }
    if (s.startsWith("UPDATE accounts SET last_synced")) {
      db.updatedAccounts.push(params![0] as string);
      return [];
    }
    throw new Error(`unexpected SQL in test: ${s.slice(0, 80)}`);
  },
  pool: { end: async () => {} },
}));

vi.mock("../src/vector/pinecone.js", () => ({
  upsertEmailVectors: async (userId: string, items: { id: string }[]) => {
    upserts.push({ userId, count: items.length, ids: items.map((i) => i.id) });
  },
}));

vi.mock("../src/ingestion/embedder.js", () => ({
  embedBatch: async (texts: string[]) => {
    embedCalls.push({ count: texts.length });
    // 1536-d fake vector, dimension matches text-embedding-3-small.
    return texts.map(() => new Array(1536).fill(0.01));
  },
}));

vi.mock("../src/auth/token.js", () => ({
  ensureFreshToken: async () => "fake-access-token",
}));

vi.mock("../src/providers/index.js", () => ({
  providerFor: () => ({
    fetchPage: async () => {
      fetchPageCalls++;
      return { emails: providerEmails, nextPageToken: undefined };
    },
  }),
}));

// ---------- helpers ------------------------------------------------------

function makeEmail(messageId: string, subject = "hello"): NormalizedEmail {
  return {
    messageId,
    threadId: `t-${messageId}`,
    senderEmail: "alice@example.com",
    senderName: "Alice",
    recipients: ["bob@example.com"],
    subject,
    bodyText: `body of ${messageId}`,
    date: "2024-01-01T00:00:00Z",
    labels: ["INBOX"],
    hasAttachments: false,
  };
}

function seedAccount(overrides: Partial<Record<string, unknown>> = {}): string {
  const acct = {
    id: "acct-1",
    user_id: "user-1",
    provider: "gmail",
    email_address: "alice@example.com",
    access_token: "enc",
    refresh_token: "enc",
    token_expires_at: null,
    last_synced: null,
    initial_sync_complete: false,
    ...overrides,
  };
  db.accounts.set(acct.id as string, acct);
  return acct.id as string;
}

// Import AFTER mocks are registered so the module graph picks up the stubs.
const { syncAccount } = await import("../src/ingestion/sync.js");

// ---------- tests --------------------------------------------------------

beforeEach(() => {
  db.accounts.clear();
  db.syncLog.length = 0;
  db.userQuota.clear();
  db.updatedAccounts.length = 0;
  upserts.length = 0;
  embedCalls.length = 0;
  providerEmails = [];
  fetchPageCalls = 0;
});

describe("syncAccount — happy path", () => {
  it("embeds and upserts every new email, logs dedup entries, bumps quota, marks account synced", async () => {
    const id = seedAccount();
    providerEmails = [makeEmail("m1"), makeEmail("m2"), makeEmail("m3")];

    const result = await syncAccount(id);

    expect(result.synced).toBe(3);
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]!.count).toBe(3);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.count).toBe(3);
    expect(db.syncLog).toHaveLength(3);
    expect(db.userQuota.get("user-1")).toBe(3);
    expect(db.updatedAccounts).toEqual([id]);
  });
});

describe("syncAccount — dedup", () => {
  it("skips messages whose content hash hasn't changed", async () => {
    const id = seedAccount();
    providerEmails = [makeEmail("m1", "first subject")];

    await syncAccount(id);
    expect(db.syncLog).toHaveLength(1);
    expect(db.userQuota.get("user-1")).toBe(1);

    // Second run with identical content should embed nothing.
    upserts.length = 0;
    embedCalls.length = 0;
    const result = await syncAccount(id);

    expect(result.synced).toBe(0);
    expect(embedCalls).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    // Quota unchanged because no new messages were indexed.
    expect(db.userQuota.get("user-1")).toBe(1);
  });

  it("re-embeds when the content hash changes (subject edit)", async () => {
    const id = seedAccount();
    providerEmails = [makeEmail("m1", "original")];
    await syncAccount(id);

    // Mutate subject — content hash should differ, triggering re-embed but
    // not incrementing the quota (message was already counted).
    providerEmails = [makeEmail("m1", "edited")];
    upserts.length = 0;
    embedCalls.length = 0;
    const result = await syncAccount(id);

    expect(result.synced).toBe(1);
    expect(embedCalls).toHaveLength(1);
    expect(upserts).toHaveLength(1);
    expect(db.userQuota.get("user-1")).toBe(1);
  });
});

describe("syncAccount — quota", () => {
  it("stops fetching once quota is exhausted", async () => {
    const id = seedAccount();
    const { EMAIL_LIMIT_PER_USER } = await import("../src/config/constants.js");

    // Pre-fill quota up to the cap. The sync must exit without fetching.
    db.userQuota.set("user-1", EMAIL_LIMIT_PER_USER);
    providerEmails = [makeEmail("m1")];

    const result = await syncAccount(id);

    expect(result.synced).toBe(0);
    expect(fetchPageCalls).toBe(0);
    expect(embedCalls).toHaveLength(0);
  });

  it("trims an over-fetched page down to the remaining quota", async () => {
    const id = seedAccount();
    const { EMAIL_LIMIT_PER_USER } = await import("../src/config/constants.js");

    db.userQuota.set("user-1", EMAIL_LIMIT_PER_USER - 2);
    providerEmails = [makeEmail("m1"), makeEmail("m2"), makeEmail("m3"), makeEmail("m4")];

    const result = await syncAccount(id);

    expect(result.synced).toBe(2);
    expect(upserts[0]!.count).toBe(2);
    expect(db.userQuota.get("user-1")).toBe(EMAIL_LIMIT_PER_USER);
  });
});

describe("syncAccount — error paths", () => {
  it("throws account_not_found when the account is missing or inactive", async () => {
    await expect(syncAccount("missing")).rejects.toThrow("account_not_found");
  });

  it("handles an empty provider page without touching embeddings or quota", async () => {
    const id = seedAccount();
    providerEmails = [];

    const result = await syncAccount(id);

    expect(result.synced).toBe(0);
    expect(embedCalls).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(db.userQuota.get("user-1")).toBeUndefined();
    // last_synced is still bumped so the scheduler doesn't requeue immediately.
    expect(db.updatedAccounts).toEqual([id]);
  });
});
