import { Router } from "express";
import { z } from "zod";
import { getUserId, requireAuth } from "../auth/jwt.js";
import { metrics } from "../metrics.js";
import { answer } from "../query/llm.js";
import { search } from "../query/search.js";

export const searchRouter: Router = Router();

// Caps enforced at the route boundary. The Pinecone + embedding path behind
// this can handle larger inputs, but there's no legitimate UX reason for a
// 10k-char "search query" — truncating here limits blast radius from
// misconfigured clients and keeps token spend bounded.
const body = z.object({
  query: z.string().min(1).max(500),
  account_ids: z.array(z.string().uuid()).max(20).optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  top_k: z.number().int().min(1).max(50).optional(),
  answer: z.boolean().optional(),
});

searchRouter.post("/", requireAuth, async (req, res) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const userId = getUserId(req);
  metrics.searchRequests.inc();
  const hits = await search({
    userId,
    query: parsed.data.query,
    accountIds: parsed.data.account_ids,
    dateFrom: parsed.data.date_from,
    dateTo: parsed.data.date_to,
    topK: parsed.data.top_k,
  });
  const grounded = parsed.data.answer ? await answer(parsed.data.query, hits) : undefined;
  res.json({ hits, answer: grounded });
});
