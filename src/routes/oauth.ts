import { type NextFunction, type Request, type Response, Router } from "express";
import jwt from "jsonwebtoken";
import { encrypt } from "../auth/crypto.js";
import { getUserId, requireAuth } from "../auth/jwt.js";
import { env } from "../config/env.js";
import { query } from "../db/client.js";
import { metrics } from "../metrics.js";
import { oauthClient } from "../providers/gmail.js";
import { syncQueue } from "../queue/queue.js";

export const oauthRouter: Router = Router();

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

function gmailScopes(cleanup: boolean): string[] {
  // gmail.modify supersedes gmail.readonly (lets us trash + untrash).
  // Only request it when the deployment enables cleanup AND the user opts in.
  const mail = cleanup && env.ENABLE_INBOX_CLEANUP ? GMAIL_MODIFY_SCOPE : GMAIL_READ_SCOPE;
  return [mail, USERINFO_SCOPE];
}

// Browser navigation can't set an Authorization header, so accept a one-shot
// JWT via ?token=… on the start route only. Header still wins if present.
function authFromHeaderOrQuery(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization?.startsWith("Bearer ")) {
    requireAuth(req, res, next);
    return;
  }
  const token = typeof req.query.token === "string" ? req.query.token : null;
  if (!token) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    req.userId = decoded.sub;
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

oauthRouter.get("/google/start", authFromHeaderOrQuery, (req, res) => {
  const cleanup = req.query.cleanup === "true" || req.query.cleanup === "1";
  const scopes = gmailScopes(cleanup);
  // Pipe-encode the cleanup intent through `state` so the callback knows which
  // scope set was granted without a separate session store.
  const state = JSON.stringify({ u: getUserId(req), c: cleanup });
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
  });
  res.redirect(url);
});

oauthRouter.get("/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const rawState = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !rawState) {
    res.status(400).json({ error: "missing_code_or_state" });
    return;
  }

  // State is JSON for new flows; fall back to treating it as a raw userId for
  // any in-flight legacy redirect that pre-dates the cleanup feature.
  let userId: string | null = null;
  let cleanup = false;
  try {
    const parsed = JSON.parse(rawState) as { u?: string; c?: boolean };
    userId = parsed.u ?? null;
    cleanup = parsed.c === true;
  } catch {
    userId = rawState;
  }
  if (!userId) {
    res.status(400).json({ error: "missing_user" });
    return;
  }

  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = await client.request<{ email: string }>({
    url: "https://openidconnect.googleapis.com/v1/userinfo",
  });
  const emailAddress = oauth2.data.email;

  const [acct] = await query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email_address, access_token, refresh_token, token_expires_at, scopes_granted)
     VALUES ($1, 'gmail', $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, email_address) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at,
           is_active = true,
           needs_reauth = false
     RETURNING id`,
    [
      userId,
      emailAddress,
      encrypt(tokens.access_token ?? ""),
      encrypt(tokens.refresh_token ?? ""),
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      gmailScopes(cleanup),
    ],
  );

  await syncQueue.add("initial", { accountId: acct!.id, kind: "initial" });
  metrics.oauthCallbacks.inc();
  res.redirect(`${new URL(env.GOOGLE_REDIRECT_URI).origin}/accounts?connected=${acct!.id}`);
});

// TODO: mirror for Microsoft (/microsoft/start, /microsoft/callback).
