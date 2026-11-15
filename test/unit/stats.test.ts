import { describe, expect, it } from "vitest";
import { CallStats, formatSummary, percentile } from "../../src/stats";

describe("percentile", () => {
  it("uses nearest rank", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.95)).toBe(100);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("CallStats", () => {
  it("summarises calls per method, failures included", () => {
    const stats = new CallStats();
    for (const ms of [100, 120, 140, 900]) stats.record("page.click", ms, false);
    stats.record("page.click", 30_000, true);
    stats.record("tabs.open", 800, false);
    const s = stats.summary();
    expect(Object.keys(s)).toEqual(["page.click", "tabs.open"]);
    expect(s["page.click"]).toEqual({ count: 5, errors: 1, p50Ms: 140, p95Ms: 30_000, maxMs: 30_000 });
    expect(formatSummary(s)).toMatch(/page\.click\s+5×\s+p50\s+140ms.*1 failed/);
  });

  it("keeps a bounded window but an exact count and max", () => {
    const stats = new CallStats();
    stats.record("page.read", 5_000, false);
    for (let i = 0; i < 1_000; i++) stats.record("page.read", 10, false);
    expect(stats.summary()["page.read"]).toMatchObject({ count: 1_001, p95Ms: 10, maxMs: 5_000 });
  });
});
