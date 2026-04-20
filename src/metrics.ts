// Tiny in-memory counters exposed at GET /metrics in Prometheus text format.
// We avoid prom-client because our whole surface is six counters — adding a
// dependency is more risk than writing the format by hand. A scraper (or a
// dashboard like Grafana Agent) polls /metrics and diffs the counters.
//
// Counters only. If we ever need histograms (e.g. per-sync duration buckets)
// switch to prom-client — don't grow this file.

class Counter {
  private value = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(n = 1): void {
    this.value += n;
  }
  get(): number {
    return this.value;
  }
}

export const metrics = {
  syncJobsStarted: new Counter("sync_jobs_started_total", "Sync jobs dequeued and started"),
  syncJobsCompleted: new Counter("sync_jobs_completed_total", "Sync jobs that finished successfully"),
  syncJobsFailed: new Counter("sync_jobs_failed_total", "Sync jobs that threw"),
  emailsIndexed: new Counter("emails_indexed_total", "Emails embedded + upserted to the vector store"),
  searchRequests: new Counter("search_requests_total", "Search API calls"),
  oauthCallbacks: new Counter(
    "oauth_callbacks_total",
    "Successful OAuth callbacks that created/updated an account",
  ),
  errors: new Counter("unhandled_errors_total", "Errors that bubbled to the Express error handler"),
};

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const counter of Object.values(metrics)) {
    lines.push(`# HELP ${counter.name} ${counter.help}`);
    lines.push(`# TYPE ${counter.name} counter`);
    lines.push(`${counter.name} ${counter.get()}`);
  }
  return `${lines.join("\n")}\n`;
}
