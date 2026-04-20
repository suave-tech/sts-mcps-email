# Tech Spec: Multi-Account Email Vector Database

**Version:** 1.0  
**Status:** Draft  
**Last Updated:** 2026-04-18

---

## 1. Overview

This system ingests emails from multiple user-owned accounts, embeds them using a cloud embedding model, and stores them in a vector database with per-user namespace isolation. Users can query across all their connected inboxes using natural language, with the AI returning grounded, cited answers from their actual email history.

---

## 2. Goals

- Connect and sync multiple email accounts (Gmail, Outlook) per user
- Embed and store whole emails as searchable vectors
- Support natural language queries across all connected inboxes
- Isolate each user's data with namespace-level access control
- Keep the vector database current via hourly polling

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     USER LAYER                          │
│  Gmail Account 1 │ Gmail Account 2 │ Outlook Account   │
└──────────────────┬──────────────────┬───────────────────┘
                   │                  │
        ┌──────────▼──────────────────▼──────────┐
        │          INGESTION SERVICE              │
        │  OAuth token store │ Polling scheduler  │
        │  Email fetcher     │ Dedup / change log  │
        └──────────────────────┬─────────────────┘
                               │
                  ┌────────────▼────────────┐
                  │    EMBEDDING SERVICE    │
                  │  Cloud Embedding API    │
                  │  (OpenAI / Cohere)      │
                  └────────────┬────────────┘
                               │
              ┌────────────────▼────────────────────┐
              │          VECTOR DATABASE             │
              │  Pinecone or Weaviate                │
              │  Namespaced per user                 │
              │  Metadata: sender, date, account,    │
              │  subject, message-id, thread-id      │
              └────────────────┬────────────────────┘
                               │
              ┌────────────────▼────────────────────┐
              │           QUERY SERVICE              │
              │  Embed query → similarity search     │
              │  Filter by namespace / account       │
              │  Return top-K chunks + metadata      │
              └────────────────┬────────────────────┘
                               │
              ┌────────────────▼────────────────────┐
              │              LLM / AI                │
              │  Grounded answer with citations      │
              └─────────────────────────────────────┘
```

---

## 4. Multi-Account Email Connection

### 4.1 Supported Providers

| Provider | Protocol | Auth Method |
|----------|----------|-------------|
| Gmail | Gmail REST API | OAuth 2.0 |
| Outlook / Microsoft 365 | Microsoft Graph API | OAuth 2.0 |
| Generic IMAP | IMAP over TLS | App password / OAuth |

### 4.2 Account Registration Flow

1. User initiates "Connect an account" in the UI.
2. System redirects to the provider's OAuth consent screen.
3. On successful auth, the system stores:
   - `user_id` (internal)
   - `account_id` (e.g. `gmail:user@example.com`)
   - `access_token` (encrypted at rest)
   - `refresh_token` (encrypted at rest)
   - `provider` (`gmail` | `outlook` | `imap`)
   - `scopes_granted`
   - `connected_at` timestamp
4. An initial full sync is triggered immediately for the new account.

### 4.3 Multiple Accounts per User

Each user can connect any number of email accounts. Accounts are tracked in an `accounts` table:

```sql
CREATE TABLE accounts (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,
  email_address TEXT NOT NULL,
  access_token  TEXT NOT NULL,    -- encrypted
  refresh_token TEXT NOT NULL,    -- encrypted
  last_synced   TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, email_address)
);
```

---

## 5. Ingestion Pipeline

### 5.1 Chunking Strategy

**Whole-email chunking** is used. Each email is treated as a single unit of embedding:

- Subject line + body text are concatenated into one string
- HTML is stripped to plain text before embedding
- Attachments are excluded in v1 (plaintext only)
- Max token length: 8,192 tokens (truncate if exceeded, preserving subject + first N body tokens)

**Concatenation format:**
```
From: {sender_name} <{sender_email}>
To: {recipients}
Date: {date}
Subject: {subject}

{body_text}
```

### 5.2 Embedding Model

**Provider:** OpenAI (primary) or Cohere (fallback)  
**Model:** `text-embedding-3-small` (1,536 dimensions) — cost-efficient with strong semantic performance  
**Upgrade path:** `text-embedding-3-large` (3,072 dimensions) for higher accuracy if needed

Each email produces exactly **one vector** per the whole-email chunking strategy.

### 5.3 Metadata Stored Alongside Each Vector

```json
{
  "user_id": "usr_abc123",
  "account_id": "gmail:alice@example.com",
  "message_id": "<unique-message-id@gmail.com>",
  "thread_id": "thread_xyz",
  "sender_email": "john@company.com",
  "sender_name": "John Smith",
  "recipients": ["alice@example.com"],
  "subject": "Q3 Budget Review",
  "date": "2026-03-15T10:22:00Z",
  "provider": "gmail",
  "has_attachments": false,
  "labels": ["INBOX", "IMPORTANT"]
}
```

### 5.4 Deduplication

- Each email is identified by its canonical `message_id` header
- Before embedding, check if `message_id` already exists in the namespace
- Skip re-embedding unless the email has been modified (e.g. labels changed)
- Track embedded emails in a `sync_log` table

---

## 6. Vector Database

### 6.1 Provider Options

| Option | Recommendation | Notes |
|--------|---------------|-------|
| **Pinecone** | ✅ Preferred for managed simplicity | Native namespace support, serverless tier available |
| **Weaviate** | ✅ Good for self-hosted / hybrid | Multi-tenancy built-in, more query flexibility |
| pgvector | Not recommended for this use case | Lacks native multi-tenant namespacing at scale |

### 6.2 Namespace Isolation Strategy

Each user gets a dedicated namespace in the vector index:

**Pinecone:**
```
Namespace: user_{user_id}
```

All upserts, queries, and deletes are scoped to this namespace. Users can never query outside their own namespace — this is enforced at the query service layer, not just by convention.

**Weaviate:**  
Use Weaviate's multi-tenancy feature with `tenant = user_{user_id}` on every class.

### 6.3 Cross-Account Search Within a Namespace

Since all of a user's accounts are stored in the same namespace, a single vector query naturally searches across all their connected inboxes. To filter to a specific account:

```python
# Search all accounts
results = index.query(vector=query_embedding, namespace=f"user_{user_id}", top_k=10)

# Filter to one account only
results = index.query(
    vector=query_embedding,
    namespace=f"user_{user_id}",
    filter={"account_id": {"$eq": "gmail:alice@example.com"}},
    top_k=10
)
```

---

## 7. Sync & Polling

### 7.1 Hourly Polling Schedule

A background worker runs every 60 minutes per active account:

```
Every 60 min per account:
  1. Refresh OAuth token if expiring within 10 min
  2. Fetch emails modified or received since `last_synced`
  3. For each new/modified email:
     a. Fetch full email content
     b. Build concatenated text (see 5.1)
     c. Call embedding API
     d. Upsert vector into Pinecone/Weaviate with metadata
     e. Log to sync_log
  4. Update accounts.last_synced = now()
```

### 7.2 Initial Full Sync

On first account connection, a full historical sync is triggered:

- Fetch all emails (paginated, most recent first)
- Process in batches of 100 emails
- Use a job queue (e.g. BullMQ, Celery) to avoid blocking the main thread
- Show sync progress to the user in the UI
- Set `initial_sync_complete = true` once done

### 7.3 Sync Job Schema

```sql
CREATE TABLE sync_jobs (
  id           UUID PRIMARY KEY,
  account_id   UUID REFERENCES accounts(id),
  status       TEXT CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  emails_synced INT DEFAULT 0,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error        TEXT
);
```

### 7.4 Token Refresh

- Access tokens should be refreshed proactively (10 min before expiry)
- If refresh fails, mark the account as `needs_reauth` and notify the user
- Do not attempt to sync an account with an invalid token

---

## 8. Query Pipeline

### 8.1 Query Flow

```
User question
    → Embed with same model (text-embedding-3-small)
    → Query Pinecone/Weaviate namespace: user_{user_id}
    → Optional: filter by account_id or date range
    → Retrieve top-10 results with metadata
    → Pass results as context to LLM
    → LLM generates grounded answer with citations
```

### 8.2 LLM Prompt Structure

```
System: You are an email assistant. Answer the user's question using ONLY 
the email excerpts provided. Always cite which email your answer comes from 
(sender, subject, date). If the answer is not found in the provided emails, 
say so clearly.

Context emails:
[1] From: john@company.com | Subject: Q3 Budget | Date: Mar 15 2026
    {email body text}

[2] From: sarah@company.com | Subject: Re: Q3 Budget | Date: Mar 16 2026
    {email body text}

User question: {user_question}
```

### 8.3 Cross-Account Search UI

The search interface should clearly show which account each result came from:

- Display account/email address alongside each result
- Allow the user to filter results by connected account via a dropdown
- Show total number of accounts searched in the result summary

---

## 9. Access Control & Privacy

### 9.1 Namespace Enforcement

- The `user_id` is derived from the authenticated session — never from user input
- Every vector operation (upsert, query, delete) must include the authenticated `user_id` as the namespace
- The query service must reject any request that does not have a valid authenticated `user_id`

### 9.2 Account-Level Access

- A user can only query emails from accounts they own
- Account ownership is verified against the `accounts` table before any sync or query
- Deleting an account triggers deletion of all vectors in that account's metadata filter

### 9.3 Data Storage

- OAuth tokens stored encrypted at rest (AES-256)
- Raw email text is not stored persistently — only the vector + metadata
- Vectors can be purged per-account or per-user on request
- Comply with GDPR right-to-erasure by deleting the namespace on account closure

---

## 10. Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend API | Node.js (Express) or Python (FastAPI) |
| Job Queue | BullMQ (Node) or Celery (Python) |
| OAuth / Token Store | Postgres (encrypted columns) |
| Embedding API | OpenAI `text-embedding-3-small` |
| Vector DB | Pinecone (managed) or Weaviate (self-hosted) |
| LLM | Claude claude-sonnet-4-20250514 via Anthropic API |
| Email APIs | Gmail API, Microsoft Graph API |
| Auth | JWT + refresh tokens (existing auth system) |
| Infrastructure | AWS / GCP — deploy ingestion workers as scheduled Lambda/Cloud Run jobs |

---

## 11. API Endpoints

### Account Management

```
POST   /api/accounts/connect          Initiate OAuth flow for a new account
GET    /api/accounts                  List all connected accounts for the user
DELETE /api/accounts/:account_id      Disconnect account + delete vectors
GET    /api/accounts/:account_id/sync Get sync status for an account
POST   /api/accounts/:account_id/sync Trigger a manual re-sync
```

### Search

```
POST   /api/search
Body: {
  query: string,
  account_ids?: string[],   // optional: filter to specific accounts
  date_from?: string,       // optional: ISO 8601
  date_to?: string,         // optional: ISO 8601
  top_k?: number            // default: 10
}
```

---

## 12. Phased Rollout

### Phase 1 — Core Pipeline (Weeks 1–3)
- Single Gmail account connection via OAuth
- Full sync on connect + hourly polling
- Whole-email embedding with OpenAI
- Pinecone storage with user namespace
- Basic natural language search endpoint

### Phase 2 — Multi-Account Support (Weeks 4–5)
- Support multiple Gmail accounts per user
- Add Outlook / Microsoft Graph integration
- Cross-account search with account-filter UI
- Sync status dashboard per account

### Phase 3 — Hardening & Scale (Weeks 6–8)
- Rate limit handling for embedding API calls
- Token refresh error recovery + user notifications
- GDPR erasure endpoint
- Observability: sync job metrics, embedding latency, query latency
- Optional: switch to Weaviate for self-hosted deployment

---

## 13. Open Questions

- Should attachment content (PDFs, Word docs) be indexed in a future phase?
- Is there a per-user email volume limit to consider for Pinecone cost management?
- Should users be able to exclude specific folders/labels (e.g. Spam, Promotions) from indexing?
- Do we need a hybrid search fallback (keyword + vector) for exact-match queries like message IDs or email addresses?
