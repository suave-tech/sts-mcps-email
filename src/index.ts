import { randomUUID } from "node:crypto";
import express from "express";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { metrics, renderPrometheus } from "./metrics.js";
import { accountsRouter } from "./routes/accounts.js";
import { cleanupRouter } from "./routes/cleanup.js";
import { oauthRouter } from "./routes/oauth.js";
import { searchRouter } from "./routes/search.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Attach a request ID + child logger to every request. Handlers pull it off
// req.log; errors in the global handler log with the same ID so a user-facing
// 500 can be correlated to the stack trace in one grep.
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Prometheus-style scrape endpoint — counters for sync jobs, search requests,
// and OAuth callbacks. Kept intentionally tiny (no prom-client dep) because
// our whole metric surface is a handful of counters.
app.get("/metrics", (_req, res) => {
  res.type("text/plain").send(renderPrometheus());
});

// Landing page after the Google OAuth callback redirects the browser here.
// Plain HTML so there's no build step; the wizard's poller is what actually
// advances the flow — this page just tells the human they can close the tab.
app.get("/accounts", (req, res) => {
  const connected = typeof req.query.connected === "string";
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${connected ? "Gmail connected" : "sts-project-vector-email"}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
      display: grid; place-items: center; background: #fafafa; color: #111; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px;
      padding: 32px 40px; max-width: 440px; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0; color: #555; }
    .ok { color: #16a34a; font-size: 32px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="card">
    ${
      connected
        ? `<div class="ok">✓</div>
    <h1>Gmail connected</h1>
    <p>You can close this tab and return to your terminal. Initial sync is running in the background.</p>`
        : `<h1>sts-project-vector-email</h1>
    <p>API is running. Start a connection flow from the CLI with <code>pnpm setup</code>.</p>`
    }
  </div>
</body>
</html>`);
});

app.use("/api/oauth", oauthRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/search", searchRouter);
if (env.ENABLE_INBOX_CLEANUP) {
  app.use("/api/cleanup", cleanupRouter);
  logger.info("inbox cleanup enabled (/api/cleanup)");
}

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const log = (req as express.Request & { log?: typeof logger }).log ?? logger;
  log.error({ err }, "unhandled route error");
  metrics.errors.inc();
  // Never echo the raw error message — it may contain decryption failures,
  // token fragments, or SQL details. The request ID (in log + response) is
  // how an operator correlates the user report to the server log.
  res.status(500).json({ error: "internal_error", requestId: req.id });
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "api listening");
});
