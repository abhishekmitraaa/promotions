/**
 * Production Metrics Exporter for Email Queue & Worker Subsystem
 *
 * Provides Prometheus-compatible text format and structured JSON formats
 * for integration with CloudWatch, Datadog, Prometheus, or Grafana.
 */

import { workerTelemetry } from "./telemetry";
import { getEmailQueueHealth } from "./health";

export interface ProductionMetricsSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  activeJobs: number;
  jobsProcessedTotal: number;
  jobsSucceededTotal: number;
  jobsFailedTotal: number;
  jobsStalledTotal: number;
  jobsSkippedTotal: number;
  averageProcessingDurationMs?: number;
  lastProcessingDurationMs?: number;
  queues: {
    transactional: { waiting: number; active: number; failed: number; delayed: number };
    campaign: { waiting: number; active: number; failed: number; delayed: number };
    events: { waiting: number; active: number; failed: number; delayed: number };
  };
  redis: {
    connected: boolean;
    latencyMs?: number;
  };
  postgres: {
    connected: boolean;
    latencyMs?: number;
  };
}

export async function getProductionMetricsSnapshot(): Promise<ProductionMetricsSnapshot> {
  const telemetry = workerTelemetry.getSnapshot();
  const queueHealth = await getEmailQueueHealth();

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: telemetry.uptimeSeconds,
    activeJobs: telemetry.activeJobs,
    jobsProcessedTotal: telemetry.jobsProcessed,
    jobsSucceededTotal: telemetry.jobsSucceeded,
    jobsFailedTotal: telemetry.jobsFailed,
    jobsStalledTotal: telemetry.jobsStalled,
    jobsSkippedTotal: telemetry.jobsSkipped,
    averageProcessingDurationMs: telemetry.averageProcessingDurationMs,
    lastProcessingDurationMs: telemetry.lastProcessingDurationMs,
    queues: queueHealth.queues,
    redis: queueHealth.redis,
    postgres: queueHealth.postgres,
  };
}

/**
 * Returns metrics in standard Prometheus text format.
 */
export async function getPrometheusMetrics(): Promise<string> {
  const snapshot = await getProductionMetricsSnapshot();

  const lines: string[] = [
    `# HELP email_worker_uptime_seconds Worker process uptime in seconds`,
    `# TYPE email_worker_uptime_seconds gauge`,
    `email_worker_uptime_seconds ${snapshot.uptimeSeconds}`,
    ``,
    `# HELP email_worker_active_jobs Number of currently executing jobs across all workers`,
    `# TYPE email_worker_active_jobs gauge`,
    `email_worker_active_jobs ${snapshot.activeJobs}`,
    ``,
    `# HELP email_jobs_total Total jobs processed by outcome`,
    `# TYPE email_jobs_total counter`,
    `email_jobs_total{status="succeeded"} ${snapshot.jobsSucceededTotal}`,
    `email_jobs_total{status="failed"} ${snapshot.jobsFailedTotal}`,
    `email_jobs_total{status="stalled"} ${snapshot.jobsStalledTotal}`,
    `email_jobs_total{status="skipped"} ${snapshot.jobsSkippedTotal}`,
    ``,
    `# HELP email_job_duration_ms Processing duration in milliseconds`,
    `# TYPE email_job_duration_ms gauge`,
    `email_job_duration_ms{type="average"} ${snapshot.averageProcessingDurationMs ?? 0}`,
    `email_job_duration_ms{type="last"} ${snapshot.lastProcessingDurationMs ?? 0}`,
    ``,
    `# HELP email_queue_depth_jobs Job depth per queue and state`,
    `# TYPE email_queue_depth_jobs gauge`,
    `email_queue_depth_jobs{queue="transactional",state="waiting"} ${snapshot.queues.transactional.waiting}`,
    `email_queue_depth_jobs{queue="transactional",state="active"} ${snapshot.queues.transactional.active}`,
    `email_queue_depth_jobs{queue="transactional",state="failed"} ${snapshot.queues.transactional.failed}`,
    `email_queue_depth_jobs{queue="transactional",state="delayed"} ${snapshot.queues.transactional.delayed}`,
    `email_queue_depth_jobs{queue="campaign",state="waiting"} ${snapshot.queues.campaign.waiting}`,
    `email_queue_depth_jobs{queue="campaign",state="active"} ${snapshot.queues.campaign.active}`,
    `email_queue_depth_jobs{queue="campaign",state="failed"} ${snapshot.queues.campaign.failed}`,
    `email_queue_depth_jobs{queue="campaign",state="delayed"} ${snapshot.queues.campaign.delayed}`,
    `email_queue_depth_jobs{queue="events",state="waiting"} ${snapshot.queues.events.waiting}`,
    `email_queue_depth_jobs{queue="events",state="active"} ${snapshot.queues.events.active}`,
    `email_queue_depth_jobs{queue="events",state="failed"} ${snapshot.queues.events.failed}`,
    `email_queue_depth_jobs{queue="events",state="delayed"} ${snapshot.queues.events.delayed}`,
    ``,
    `# HELP email_backend_connected Connection status of backend services (1=up, 0=down)`,
    `# TYPE email_backend_connected gauge`,
    `email_backend_connected{service="redis"} ${snapshot.redis.connected ? 1 : 0}`,
    `email_backend_connected{service="postgres"} ${snapshot.postgres.connected ? 1 : 0}`,
    ``,
    `# HELP email_backend_latency_ms Latency in milliseconds to backend services`,
    `# TYPE email_backend_latency_ms gauge`,
    `email_backend_latency_ms{service="redis"} ${snapshot.redis.latencyMs ?? 0}`,
    `email_backend_latency_ms{service="postgres"} ${snapshot.postgres.latencyMs ?? 0}`,
  ];

  return lines.join("\n") + "\n";
}
