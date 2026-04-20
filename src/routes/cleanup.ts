import { Router } from "express";
import { getUserId, requireAuth } from "../auth/jwt.js";
import { CleanupRules } from "../cleanup/rules.js";
import { CleanupError, previewCleanup, runCleanup } from "../cleanup/runner.js";

export const cleanupRouter: Router = Router();
cleanupRouter.use(requireAuth);

cleanupRouter.post("/preview", async (req, res) => {
  try {
    const { accountId, rules } = parseBody(req.body);
    const result = await previewCleanup(getUserId(req), accountId, rules);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

cleanupRouter.post("/run", async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: "confirm_required", message: "pass {confirm: true} to execute" });
      return;
    }
    const { accountId, rules } = parseBody(req.body);
    const result = await runCleanup(getUserId(req), accountId, rules);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

function parseBody(body: unknown): { accountId: string; rules: CleanupRules } {
  const b = body as { accountId?: unknown; rules?: unknown };
  if (typeof b?.accountId !== "string") throw new CleanupError("accountId_required", 400);
  const rules = CleanupRules.parse(b.rules ?? {});
  return { accountId: b.accountId, rules };
}

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof CleanupError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  throw err;
}
