import { z } from "zod";

// User-facing cleanup rules. Kept intentionally small — Gmail's search DSL
// already expresses most of what people want to delete, so we lean on it.
// Array caps here prevent a runaway rule from ballooning the Gmail query
// string or the result set; tune the 100 if you need bigger allowlists.
export const CleanupRules = z.object({
  // Match senders by full address ("promos@brand.com") or by domain ("@brand.com").
  senders: z.array(z.string().min(1).max(200)).max(100).default([]),

  // Gmail system/category labels, e.g. "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL".
  labels: z.array(z.string().min(1).max(100)).max(50).default([]),

  // Subject substrings (case-insensitive, whole-phrase match via Gmail quoting).
  subjectMatches: z.array(z.string().min(1).max(200)).max(50).default([]),

  // Gmail's `has:list` matches messages with List-Unsubscribe headers —
  // a strong signal for newsletters / fashion drops / transactional marketing.
  hasUnsubscribe: z.boolean().default(false),

  olderThanDays: z.number().int().positive().max(3650).optional(),

  // Veto rules. Anything matching `keep` is excluded from deletion even if
  // it would otherwise be caught by the filters above.
  keep: z
    .object({
      senders: z.array(z.string().min(1).max(200)).max(100).default([]),
      labels: z.array(z.string().min(1).max(100)).max(50).default([]),
      subjectMatches: z.array(z.string().min(1).max(200)).max(50).default([]),
    })
    .default({ senders: [], labels: [], subjectMatches: [] }),

  // Hard ceiling per run. Prevents a misconfigured rule from emptying an inbox.
  maxMessages: z.number().int().positive().max(5000).default(500),
});
export type CleanupRules = z.infer<typeof CleanupRules>;

/**
 * Translate rules into a Gmail search query string. We always exclude
 * STARRED + IMPORTANT as implicit safety rails; users can still see those
 * in the preview count if they really want, but they won't be touched.
 */
export function rulesToGmailQuery(rules: CleanupRules): string {
  const parts: string[] = [];

  if (rules.senders.length > 0) {
    parts.push(`(${rules.senders.map((s) => `from:${quote(s)}`).join(" OR ")})`);
  }

  if (rules.labels.length > 0) {
    parts.push(`(${rules.labels.map(labelToQuery).join(" OR ")})`);
  }

  if (rules.subjectMatches.length > 0) {
    parts.push(`(${rules.subjectMatches.map((s) => `subject:${quote(s)}`).join(" OR ")})`);
  }

  if (rules.hasUnsubscribe) parts.push("has:list");
  if (rules.olderThanDays) parts.push(`older_than:${rules.olderThanDays}d`);

  // Veto rules → negative filters so Gmail narrows the result before we fetch.
  for (const s of rules.keep.senders) parts.push(`-from:${quote(s)}`);
  for (const l of rules.keep.labels) parts.push(`-${labelToQuery(l)}`);
  for (const s of rules.keep.subjectMatches) parts.push(`-subject:${quote(s)}`);

  // Implicit safety rails — never touch starred or marked-important.
  parts.push("-is:starred", "-is:important");

  return parts.join(" ");
}

function quote(raw: string): string {
  // Gmail accepts quoted phrases for exact-substring matches. Escape any
  // embedded quotes by stripping — the rule author can always split instead.
  const cleaned = raw.replace(/"/g, "");
  return /[\s:]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function labelToQuery(label: string): string {
  if (label.startsWith("CATEGORY_")) return `category:${label.slice("CATEGORY_".length).toLowerCase()}`;
  return `label:${label.toLowerCase()}`;
}
