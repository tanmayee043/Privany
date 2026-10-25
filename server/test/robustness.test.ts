import { describe, expect, it, vi } from "vitest";
import { isTransientNavError, JobTimeoutError, rateLimit, withTimeout } from "../src/limits.js";

describe("withTimeout", () => {
  it("passes through a result that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "slow")).resolves.toBe(7);
  });

  it("rejects with JobTimeoutError when the work hangs", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "too slow")).rejects.toBeInstanceOf(JobTimeoutError);
  });
});

describe("rateLimit", () => {
  const run = (limiter: ReturnType<typeof rateLimit>, ip: string) => {
    const res = { headers: {} as Record<string, string>, code: 200, setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.code = c; return this; }, json: vi.fn() };
    const next = vi.fn();
    limiter({ ip } as never, res as never, next);
    return { res, next };
  };

  it("allows up to max requests per window, then answers 429 with Retry-After", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 2 });
    expect(run(limiter, "1.1.1.1").next).toHaveBeenCalled();
    expect(run(limiter, "1.1.1.1").next).toHaveBeenCalled();
    const blocked = run(limiter, "1.1.1.1");
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.code).toBe(429);
    expect(Number(blocked.res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("counts each client separately", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    run(limiter, "1.1.1.1");
    expect(run(limiter, "2.2.2.2").next).toHaveBeenCalled();
  });
});

describe("isTransientNavError", () => {
  it("retries network blips and unknown errors", () => {
    expect(isTransientNavError("The site couldn't be reached.")).toBe(true);
    expect(isTransientNavError("net::ERR_CONNECTION_RESET")).toBe(true);
    expect(isTransientNavError("Protocol error: Target closed")).toBe(true);
  });

  it("doesn't retry failures that will repeat", () => {
    expect(isTransientNavError("The site's address couldn't be found.")).toBe(false);
    expect(isTransientNavError("The site's security certificate was rejected.")).toBe(false);
    expect(isTransientNavError("The site pointed to a private network address, so the test stopped.")).toBe(false);
    expect(isTransientNavError("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
  });
});
