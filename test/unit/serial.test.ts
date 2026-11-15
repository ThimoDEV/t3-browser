// Screenshot tab switches and tab-group creation must not interleave between threads.
import { describe, expect, it } from "vitest";
import { createKeyedQueue, createQueue } from "../../extension/src/serial";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("createQueue", () => {
  it("runs jobs one at a time, in arrival order", async () => {
    const queue = createQueue();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`${name} start`);
      await tick();
      log.push(`${name} end`);
      return name;
    };
    expect(await Promise.all([queue(job("a")), queue(job("b")), queue(job("c"))])).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("keeps going after a job fails, and reports the failure to its caller", async () => {
    const queue = createQueue();
    const failed = queue(async () => {
      throw new Error("capture failed");
    });
    const next = queue(async () => "next ran");
    await expect(failed).rejects.toThrow("capture failed");
    expect(await next).toBe("next ran");
  });
});

describe("createKeyedQueue", () => {
  it("serialises per key but lets different keys run side by side", async () => {
    const queue = createKeyedQueue();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`${name} start`);
      await tick();
      log.push(`${name} end`);
    };
    await Promise.all([queue("thread-1", job("1a")), queue("thread-2", job("2a")), queue("thread-1", job("1b"))]);
    expect(log.indexOf("1a end")).toBeLessThan(log.indexOf("1b start"));
    expect(log.indexOf("2a start")).toBeLessThan(log.indexOf("1a end"));
  });
});
