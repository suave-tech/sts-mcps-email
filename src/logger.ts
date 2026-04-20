import { type Logger, pino } from "pino";

// Single shared logger. In production we emit JSON (one object per line, ready
// for any log aggregator); in development we pretty-print for readability.
// Child loggers inherit level + bindings — that's how request-scoped IDs
// propagate without every call site passing them explicitly.
const isDev = process.env.NODE_ENV !== "production";

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  base: { service: "sts-vector-email" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service" },
        },
      }
    : {}),
  redact: {
    // Never let tokens or keys escape into logs, even by accident.
    paths: [
      "access_token",
      "refresh_token",
      "authorization",
      "req.headers.authorization",
      "*.access_token",
      "*.refresh_token",
      "password",
    ],
    remove: true,
  },
});
