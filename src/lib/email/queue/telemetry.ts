/**
 * Email Worker Telemetry & Distributed Heartbeat System
 *
 * Tracks live operational metrics of the background worker:
 * - Active jobs count (in-flight concurrency)
 * - Processed, succeeded, failed, stalled, and skipped job counts
 * - Processing duration & rolling latency average
 * - Last successful send timestamp & recipient
 * - Last provider error timestamp, code, and sanitized message
 * - Writes heartbeats to Redis for distributed observability by the admin dashboard
 */

import os from "os";
import { Redis } from "ioredis";
import { workerLogger, maskEmailForLogs } from "./worker-logger";

export interface LastSendInfo {
  timestamp: string;
  deliveryId?: string;
  recipient?: string;
  providerType?: string;
}

export interface LastErrorInfo {
  timestamp: string;
  code?: string;
  message: string;
}

export interface WorkerTelemetrySnapshot {
  workerId: string;
  hostname: string;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  activeJobs: number;
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsStalled: number;
  jobsSkipped: number;
  lastProcessingDurationMs?: number;
  averageProcessingDurationMs?: number;
  lastSuccessfulSend?: LastSendInfo;
  lastProviderError?: LastErrorInfo;
  lastHeartbeatAt?: string;
  status: "HEALTHY" | "DEGRADED" | "STOPPING" | "STOPPED";
}

class WorkerTelemetry {
  public readonly workerId: string;
  public readonly hostname: string;
  public readonly pid: number;
  public readonly startedAt: Date;

  private activeJobs = 0;
  private jobsProcessed = 0;
  private jobsSucceeded = 0;
  private jobsFailed = 0;
  private jobsStalled = 0;
  private jobsSkipped = 0;

  private totalDurationMs = 0;
  private timedJobsCount = 0;
  private lastDurationMs?: number;

  private lastSuccessfulSend?: LastSendInfo;
  private lastProviderError?: LastErrorInfo;
  private status: "HEALTHY" | "DEGRADED" | "STOPPING" | "STOPPED" = "HEALTHY";

  private heartbeatInterval?: NodeJS.Timeout;

  constructor() {
    this.workerId = `worker_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.hostname = os.hostname();
    this.pid = process.pid;
    this.startedAt = new Date();
  }

  getWorkerId(): string {
    return this.workerId;
  }

  recordJobStart(): number {
    this.activeJobs++;
    return Date.now();
  }

  recordJobSuccess(startTimeMs: number, info?: { deliveryId?: string; recipient?: string; providerType?: string }) {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    this.jobsProcessed++;
    this.jobsSucceeded++;

    const duration = Date.now() - startTimeMs;
    this.lastDurationMs = duration;
    this.totalDurationMs += duration;
    this.timedJobsCount++;

    this.lastSuccessfulSend = {
      timestamp: new Date().toISOString(),
      deliveryId: info?.deliveryId,
      recipient: info?.recipient ? maskEmailForLogs(info.recipient) : undefined,
      providerType: info?.providerType,
    };
  }

  recordJobFailure(startTimeMs: number, error: unknown) {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    this.jobsProcessed++;
    this.jobsFailed++;

    const duration = Date.now() - startTimeMs;
    this.lastDurationMs = duration;
    this.totalDurationMs += duration;
    this.timedJobsCount++;

    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode = (error as Record<string, unknown>)?.code as string | undefined;

    this.lastProviderError = {
      timestamp: new Date().toISOString(),
      code: errCode || "JOB_FAILED",
      message: errMsg.length > 200 ? `${errMsg.substring(0, 200)}...` : errMsg,
    };
  }

  recordJobStalled() {
    this.jobsStalled++;
  }

  recordJobSkipped() {
    this.jobsSkipped++;
  }

  setStatus(status: "HEALTHY" | "DEGRADED" | "STOPPING" | "STOPPED") {
    this.status = status;
  }

  getSnapshot(): WorkerTelemetrySnapshot {
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const averageProcessingDurationMs =
      this.timedJobsCount > 0 ? Math.round(this.totalDurationMs / this.timedJobsCount) : undefined;

    return {
      workerId: this.workerId,
      hostname: this.hostname,
      pid: this.pid,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds,
      activeJobs: this.activeJobs,
      jobsProcessed: this.jobsProcessed,
      jobsSucceeded: this.jobsSucceeded,
      jobsFailed: this.jobsFailed,
      jobsStalled: this.jobsStalled,
      jobsSkipped: this.jobsSkipped,
      lastProcessingDurationMs: this.lastDurationMs,
      averageProcessingDurationMs,
      lastSuccessfulSend: this.lastSuccessfulSend,
      lastProviderError: this.lastProviderError,
      lastHeartbeatAt: new Date().toISOString(),
      status: this.status,
    };
  }

  /**
   * Publishes a heartbeat record to Redis with a 30s TTL.
   */
  async writeHeartbeat(redis: Redis): Promise<void> {
    try {
      const snapshot = this.getSnapshot();
      const key = `email:worker:heartbeat:${this.workerId}`;
      const payload = JSON.stringify(snapshot);

      await redis.pipeline()
        .set(key, payload, "EX", 30) // 30-second TTL
        .sadd("email:worker:active_ids", this.workerId)
        .exec();
    } catch (err) {
      workerLogger.warn("Failed to publish worker heartbeat to Redis", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cleans up the heartbeat key in Redis on graceful shutdown.
   */
  async clearHeartbeat(redis: Redis): Promise<void> {
    try {
      this.status = "STOPPED";
      const key = `email:worker:heartbeat:${this.workerId}`;
      await redis.pipeline()
        .del(key)
        .srem("email:worker:active_ids", this.workerId)
        .exec();
    } catch {
      // Ignored during shutdown
    }
  }

  /**
   * Starts periodic heartbeat emission to Redis (default every 10 seconds).
   */
  startHeartbeat(redis: Redis, intervalMs: number = 10000) {
    if (this.heartbeatInterval) return;

    // Initial publish
    void this.writeHeartbeat(redis);

    this.heartbeatInterval = setInterval(() => {
      void this.writeHeartbeat(redis);
    }, intervalMs);

    // Unref so timer doesn't prevent process exit
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  async stopHeartbeat(redis?: Redis): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (redis) {
      await this.clearHeartbeat(redis);
    }
  }
}

export const workerTelemetry = new WorkerTelemetry();

/**
 * Retrieves all currently active worker heartbeats from Redis.
 * Used by health endpoints and admin dashboards to report live worker cluster state.
 */
export async function getActiveWorkerHeartbeats(redis: Redis): Promise<WorkerTelemetrySnapshot[]> {
  try {
    const workerIds = await redis.smembers("email:worker:active_ids");
    if (!workerIds || workerIds.length === 0) return [];

    const keys = workerIds.map((id) => `email:worker:heartbeat:${id}`);
    const results = await redis.mget(...keys);

    const activeWorkers: WorkerTelemetrySnapshot[] = [];
    const expiredIds: string[] = [];

    results.forEach((data, index) => {
      const id = workerIds[index];
      if (data) {
        try {
          activeWorkers.push(JSON.parse(data));
        } catch {
          expiredIds.push(id);
        }
      } else {
        expiredIds.push(id);
      }
    });

    // Clean up expired IDs asynchronously
    if (expiredIds.length > 0) {
      void redis.srem("email:worker:active_ids", ...expiredIds).catch(() => {});
    }

    return activeWorkers;
  } catch (err) {
    workerLogger.warn("Failed to fetch active worker heartbeats from Redis", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
