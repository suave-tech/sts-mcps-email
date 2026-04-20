import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the Google OAuth callback flow. Stubs the google
// client (code → tokens → email) and the sync queue, then drives real
// Express route handlers with supertest-style fetch against a live server.

const accountInserts: unknown[][] = [];
const queueAdds: Array<{ name: string; payload: unknown }> = [];

vi.mock("../src/db/client.js", () => ({
  query: async (_sql: string, params?: unknown[]) => {
    accountInserts.push(params ?? []);
    return [{ id: "acct-from-db" }];
  },
  pool: { end: async () => {} },
}));

vi.mock("../src/queue/queue.js", () => ({
  syncQueue: {
    add: async (name: string, payload: unknown) => {
      queueAdds.push({ name, payload });
    },
  },
}));

vi.mock("../src/providers/gmail.js", () => ({
  oauthClient: () => ({
    getToken: async (code: string) => {
      if (code === "bad-code") throw new Error("invalid_grant");
      return {
        tokens: {
          access_token: "ya29.fake",
          refresh_token: "1//fake-refresh",
          expiry_date: Date.now() + 3600_000,
        },
      };
    },
    setCredentials: () => {},
    request: async () => ({ data: { email: "alice@example.com" } }),
    generateAuthUrl: () => "https://accounts.google.com/fake",
  }),
}));

// Import the router after mocks are registered.
const { oauthRouter } = await import("../src/routes/oauth.js");

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/oauth", oauthRouter);
  return app;
}

async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = makeApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

beforeEach(() => {
  accountInserts.length = 0;
  queueAdds.length = 0;
});

describe("GET /api/oauth/google/callback", () => {
  it("creates the account, kicks off initial sync, and redirects to the success page", async () => {
    const { url, close } = await startApp();
    try {
      const state = JSON.stringify({ u: "user-abc", c: false });
      const res = await fetch(
        `${url}/api/oauth/google/callback?code=good&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/\/accounts\?connected=acct-from-db$/);

      expect(accountInserts).toHaveLength(1);
      const [insertParams] = accountInserts;
      expect(insertParams![0]).toBe("user-abc");
      expect(insertParams![1]).toBe("alice@example.com");

      expect(queueAdds).toEqual([
        { name: "initial", payload: { accountId: "acct-from-db", kind: "initial" } },
      ]);
    } finally {
      await close();
    }
  });

  it("400s when code or state is missing", async () => {
    const { url, close } = await startApp();
    try {
      const res = await fetch(`${url}/api/oauth/google/callback?code=only`, { redirect: "manual" });
      expect(res.status).toBe(400);
      expect(accountInserts).toHaveLength(0);
      expect(queueAdds).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("falls back to treating state as a raw userId when it's not JSON (legacy in-flight redirects)", async () => {
    const { url, close } = await startApp();
    try {
      const res = await fetch(`${url}/api/oauth/google/callback?code=good&state=user-legacy`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(accountInserts[0]![0]).toBe("user-legacy");
    } finally {
      await close();
    }
  });

  it("400s when the parsed state has no user id", async () => {
    const { url, close } = await startApp();
    try {
      const state = JSON.stringify({ c: true });
      const res = await fetch(
        `${url}/api/oauth/google/callback?code=good&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe("GET /api/oauth/google/start", () => {
  it("redirects to Google with a signed state carrying the user id", async () => {
    const { sign } = await import("../src/auth/jwt.js");
    const token = sign("user-xyz");
    const { url, close } = await startApp();
    try {
      const res = await fetch(`${url}/api/oauth/google/start?token=${token}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://accounts.google.com/fake");
    } finally {
      await close();
    }
  });

  it("401s when no JWT is supplied", async () => {
    const { url, close } = await startApp();
    try {
      const res = await fetch(`${url}/api/oauth/google/start`, { redirect: "manual" });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("401s when the JWT is malformed", async () => {
    const { url, close } = await startApp();
    try {
      const res = await fetch(`${url}/api/oauth/google/start?token=not-a-jwt`, { redirect: "manual" });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});
