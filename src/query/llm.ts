import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import type { SearchHit } from "./search.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const SYSTEM =
  "You are an email assistant. Answer the user's question using ONLY the email excerpts provided. " +
  "Always cite which email your answer comes from (sender, subject, date). " +
  "If the answer is not found in the provided emails, say so clearly.";

// Raw body text isn't stored server-side (see TECH-SPEC §9.3), so context is
// built entirely from the metadata Pinecone returns. If body snippets are
// added later, include them here.
function buildContext(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const m = h.metadata;
      return (
        `[${i + 1}] From: ${m.sender_email} | Subject: ${m.subject} | Date: ${m.date}\n` +
        `    (account: ${m.account_id}, message-id: ${m.message_id})`
      );
    })
    .join("\n\n");
}

export async function answer(question: string, hits: SearchHit[]): Promise<string> {
  const message = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Context emails:\n${buildContext(hits)}\n\nUser question: ${question}`,
      },
    ],
  });

  const block = message.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}
