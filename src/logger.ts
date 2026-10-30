import pino from "pino";

/** JSON logs to stdout (Replit's deployment log reads them). LOG_LEVEL=debug for more. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "financier-db" },
  redact: { paths: ["req.headers.authorization", "req.headers['x-api-key']", "*.password", "*.secret", "*.token"], censor: "[redacted]" },
});
