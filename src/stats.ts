// Per-method timing for calls into Chrome, kept in memory by the daemon and shown by
// `t3-browser doctor`. "Performance is a feature": this is how a slow step gets noticed.

const KEEP = 200;

export interface MethodSummary {
  count: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export class CallStats {
  private methods = new Map<string, { count: number; errors: number; maxMs: number; recent: number[] }>();

  record(method: string, ms: number, failed: boolean): void {
    let m = this.methods.get(method);
    if (!m) this.methods.set(method, (m = { count: 0, errors: 0, maxMs: 0, recent: [] }));
    m.count++;
    if (failed) m.errors++;
    m.maxMs = Math.max(m.maxMs, ms);
    m.recent.push(ms);
    if (m.recent.length > KEEP) m.recent.shift();
  }

  summary(): Record<string, MethodSummary> {
    const out: Record<string, MethodSummary> = {};
    for (const [method, m] of [...this.methods].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...m.recent].sort((a, b) => a - b);
      out[method] = { count: m.count, errors: m.errors, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: m.maxMs };
    }
    return out;
  }
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function formatSummary(summary: Record<string, MethodSummary>): string {
  const rows = Object.entries(summary);
  if (!rows.length) return "  (no calls yet)";
  const w = Math.max(...rows.map(([m]) => m.length));
  return rows
    .map(([m, s]) => `  ${m.padEnd(w)}  ${String(s.count).padStart(5)}×  p50 ${String(s.p50Ms).padStart(5)}ms  p95 ${String(s.p95Ms).padStart(5)}ms  max ${String(s.maxMs).padStart(6)}ms${s.errors ? `  ${s.errors} failed` : ""}`)
    .join("\n");
}
