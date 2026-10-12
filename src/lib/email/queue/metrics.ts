/**
 * Job Queue Metrics Exporter
 *
 * Structured JSON and Prometheus text formats derived from the PostgreSQL BackgroundJob table.
 */

import { getEmailQueueHealth, EmailQueueHealthReport } from "./health";

export interface ProductionMetricsSnapshot {
  timestamp: string;
  processor: EmailQueueHealthReport["processor"];
  queues: {
    transactional: { waiting: number; active: number; failed: number; delayed: number; completed: number };
    campaign: { waiting: number; active: number; failed: number; delayed: number; completed: number };
    events: { waiting: number; active: number; failed: number; delayed: number; completed: number };
  };
  postgres: {
    connected: boolean;
    latencyMs?: number;
  };
}

export async function getProductionMetricsSnapshot(): Promise<ProductionMetricsSnapshot> {
  const health = await getEmailQueueHealth();
  return {
    timestamp: health.timestamp,
    processor: health.processor,
    queues: health.queues,
    postgres: { connected: health.postgres.connected, latencyMs: health.postgres.latencyMs },
  };
}

/**
 * Returns metrics in standard Prometheus text format.
 */
export async function getPrometheusMetrics(): Promise<string> {
  const snapshot = await getProductionMetricsSnapshot();
  const lines: string[] = [
    `# HELP email_queue_depth_jobs Job depth per queue and state`,
    `# TYPE email_queue_depth_jobs gauge`,
  ];
  for (const [queue, counts] of Object.entries(snapshot.queues)) {
    for (const state of ["waiting", "active", "failed", "delayed", "completed"] as const) {
      lines.push(`email_queue_depth_jobs{queue="${queue}",state="${state}"} ${counts[state]}`);
    }
  }
  lines.push(
    ``,
    `# HELP email_processor_stalled Whether runnable jobs have waited past the stall threshold (1=stalled)`,
    `# TYPE email_processor_stalled gauge`,
    `email_processor_stalled ${snapshot.processor.status === "STALLED" ? 1 : 0}`,
    ``,
    `# HELP email_processor_oldest_runnable_job_age_ms Age of the oldest runnable queued job`,
    `# TYPE email_processor_oldest_runnable_job_age_ms gauge`,
    `email_processor_oldest_runnable_job_age_ms ${snapshot.processor.oldestRunnableJobAgeMs ?? 0}`,
    ``,
    `# HELP email_backend_connected Connection status of PostgreSQL (1=up, 0=down)`,
    `# TYPE email_backend_connected gauge`,
    `email_backend_connected{service="postgres"} ${snapshot.postgres.connected ? 1 : 0}`,
    ``,
    `# HELP email_backend_latency_ms Latency in milliseconds to PostgreSQL`,
    `# TYPE email_backend_latency_ms gauge`,
    `email_backend_latency_ms{service="postgres"} ${snapshot.postgres.latencyMs ?? 0}`
  );
  return lines.join("\n") + "\n";
}
