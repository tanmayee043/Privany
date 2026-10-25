import type { NextFunction, Request, Response } from "express";

/** Thrown when too many checks are already waiting; the API turns it into a 503. */
export class QueueFullError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Privany is busy with other checks right now. Try again in a minute.");
  }
}

export class JobTimeoutError extends Error {}

/** Rejects with JobTimeoutError if `promise` hasn't settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sliding-window limiter keyed by client address. The server only listens on
 * 127.0.0.1, so this mostly protects against a runaway script or a page in the
 * browser hammering the API, not against the public internet.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests. Wait a moment and try again." });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

/**
 * False for failures that will just repeat (the address doesn't exist, the
 * certificate is bad, the site points at a private network); true for
 * anything else. Takes the raw browser error or Privany's plain-language
 * rewording of it.
 */
export function isTransientNavError(message: string): boolean {
  return !/ERR_NAME_NOT_RESOLVED|ERR_BLOCKED_BY_CLIENT|ERR_CERT|ERR_ADDRESS_UNREACHABLE|couldn't be found|private network|certificate/i.test(message);
}
