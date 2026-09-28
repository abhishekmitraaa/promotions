# Production Email Worker Deployment & Topology Guide

This guide specifies the production deployment architecture, infrastructure topology, scaling strategy, and operations runbook for the WhatsApp Hub dedicated Email Worker (`npm run worker:email`).

---

> [!CAUTION]
> **CRITICAL ARCHITECTURAL REQUIREMENT: DO NOT DEPLOY TO NETLIFY SERVERLESS**
> The background Email Worker (`workers/email-worker.ts`) **MUST NEVER** be deployed as a Netlify serverless or Edge function.
> 
> **Why Netlify Serverless is Prohibited:**
> 1. **Execution Time Limits**: Netlify functions terminate after 10–26 seconds, aborting long-running campaign batches and active email provider API dispatches mid-stream.
> 2. **Immediate Socket Severing**: Serverless runtimes freeze or tear down the Node.js event loop immediately after HTTP response delivery, breaking BullMQ Redis lock renewals (`lockDuration`).
> 3. **Absence of Graceful Drain**: Serverless environments do not support `SIGTERM` / `SIGINT` graceful drain hooks, abandoning in-flight jobs into zombie `PROCESSING` states.
> 4. **Connection Proliferation**: Spin-up of ephemeral serverless containers causes catastrophic connection spikes to PostgreSQL and Redis.
>
> **The email worker MUST be deployed as a persistent, long-running daemon process** on AWS ECS, Kubernetes, a dedicated VM (systemd), or via PM2.

---

## 1. System Topology Overview

```
                                  +------------------------------------+
                                  |    Next.js Web / Admin Dashboard   |
                                  |      (Serverless / Web Tier)       |
                                  +-----------------+------------------+
                                                    |
                                                    | Enqueues Jobs / Health Probes
                                                    v
+-----------------------+         +-----------------+------------------+         +-----------------------+
|  Email Worker Node 1  |<------->|       Durable Redis Cluster        |<------->|  Email Worker Node 2  |
|  (Persistent Daemon)  |         | (Queues, Locks, Heartbeats, Delay) |         |  (Persistent Daemon)  |
+-----------+-----------+         +-----------------+------------------+         +-----------+-----------+
            |                                       ^                                        |
            | Queries & Writes                      |                                        | Queries & Writes
            v                                       v                                        v
+-----------+---------------------------------------+----------------------------------------+-----------+
|                                           PostgreSQL Database                                          |
|                       (Authoritative Delivery State Machine & Multi-Tenant Data)                       |
+--------------------------------------------------------------------------------------------------------+
```

---

## 2. Infrastructure Specifications

### A. Worker Host
- **Runtime**: Node.js `>=22.12.0`
- **Command**: `npm run worker:email` (equivalent to `npx tsx workers/email-worker.ts`)
- **Process Memory**: Minimum 512MB RAM per worker instance; recommended 1GB–2GB RAM for production workloads.
- **CPU**: 1–2 vCPUs per worker instance.
- **Process Model**: Long-running single process managing BullMQ workers for 4 queues:
  - `email-transactional` (Immediate priority dispatches)
  - `email-promotional-delivery` (Parallel audience delivery workers)
  - `email-promotional` (Campaign batch trigger orchestration)
  - `email-events` (Webhook delivery status, bounce, and complaint processing)

### B. Redis Topology
- **Version**: Redis 7.0+ (Standalone, Sentinel, or AWS ElastiCache / Redis Cluster)
- **Memory Policy**: `maxmemory-policy noeviction` (**MANDATORY**).
  > [!IMPORTANT]
  > BullMQ queues, delayed sets, and lock keys must never be evicted by LRU/LFU memory policies.
- **Persistence**: AOF enabled (`appendonly yes`, `appendfsync everysec`) and/or RDB snapshots every 15 minutes.
- **Max Connections**: Allocate at least 15 connections per active worker instance (pub/sub, queue listeners, heartbeats, and worker client instances).
- **Client Configuration**:
  - Queue Producers: `maxRetriesPerRequest: 3`
  - BullMQ Workers: `maxRetriesPerRequest: null` (required by BullMQ blocking commands)
  - Reconnection Strategy: Exponential backoff with jitter up to 3000ms.

### C. PostgreSQL Database Topology
- **Version**: PostgreSQL 15+
- **Connection Configuration**:
  - Workers perform authoritative state updates (e.g. `EmailDelivery`, `EmailCampaignRecipient`).
  - Use `DATABASE_URL` (direct connection or pooled connection via PgBouncer in transaction mode).
  - Minimum pool size: 5 connections per worker instance.
  - Query timeouts: 15,000ms statement timeout.

---

## 3. Worker Lifecycle & Resilience

### A. Startup Validation Sequence
Before accepting any queue jobs, the worker daemon executes `validateEnvironment()`:
1. **Redis Ping Check**: Validates network connectivity and round-trip latency (`<100ms`). Logs masked target URL without exposing passwords.
2. **PostgreSQL Connectivity Check**: Executes `SELECT 1` and records latency.
3. **Schema Verification**: Confirms accessibility of core tables (`EmailDelivery`, `EmailCampaign`, `EmailCampaignRecipient`, `EmailEvent`, `EmailProviderConfig`).
4. **Startup Reconciliation**: Executes `reconcileAbandonedJobs()` to recover any jobs left in `PROCESSING` status from previous crashes or ungraceful terminations.
5. **Heartbeat Registration**: Initiates distributed 10-second heartbeat to Redis (`email:worker:heartbeat:{workerId}`) with 30-second TTL.

### B. Graceful Shutdown & Drain (`SIGTERM` / `SIGINT`)
Upon receiving `SIGTERM` or `SIGINT`:
1. Sets `isShuttingDown = true` (idempotent shutdown guard).
2. Clears periodic timers (heartbeat and 5-minute reconciliation loop).
3. Stops Redis heartbeat publishing and deletes the worker's key from `email:worker:active_ids`.
4. Pauses all 4 BullMQ workers (`worker.pause()`) to prevent accepting new jobs.
5. Awaits completion of in-flight jobs with a bounded 15-second drain timeout (`SHUTDOWN_TIMEOUT_MS = 15000`).
6. Closes all workers (`worker.close()`).
7. Gracefully releases Redis connections and disconnects Prisma PostgreSQL client.
8. Exits with code `0`. If the drain hangs past 15 seconds, forces exit with code `1`.

---

## 4. Deployment Configurations

### Option 1: Systemd Service (Dedicated Linux VM / AWS EC2)
File: `/etc/systemd/system/email-worker.service`

```ini
[Unit]
Description=WhatsApp Hub Email Background Worker
After=network.target redis.target postgresql.target
Wants=network.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/var/www/whatsapp-hub
EnvironmentFile=/var/www/whatsapp-hub/.env.production
ExecStart=/usr/bin/npm run worker:email
Restart=always
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=25s
LimitNOFILE=65536

# Sandboxing
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

### Option 2: Docker Container & Docker Compose
File: `docker-compose.worker.yml`

```yaml
version: '3.8'

services:
  email-worker:
    image: whatsapp-hub:latest
    command: ["npm", "run", "worker:email"]
    restart: always
    stop_grace_period: 25s
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      EMAIL_WORKER_CONCURRENCY: 5
      EMAIL_DELIVERY_CONCURRENCY: 10
      EMAIL_CAMPAIGN_CONCURRENCY: 2
      EMAIL_EVENTS_CONCURRENCY: 10
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 1024M
        reservations:
          cpus: '0.25'
          memory: 512M
```

### Option 3: Kubernetes Deployment
File: `k8s/email-worker-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: email-worker
  namespace: default
  labels:
    app: email-worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: email-worker
  template:
    metadata:
      labels:
        app: email-worker
    spec:
      terminationGracePeriodSeconds: 30
      containers:
      - name: worker
        image: your-registry/whatsapp-hub:production
        command: ["npm", "run", "worker:email"]
        envFrom:
        - secretRef:
            name: email-worker-secrets
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1024Mi
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 2"]
```

### Option 4: PM2 Ecosystem
File: `ecosystem.config.js`

```javascript
module.exports = {
  apps: [
    {
      name: 'email-worker',
      script: 'npm',
      args: 'run worker:email',
      instances: 2,
      exec_mode: 'cluster',
      kill_timeout: 20000,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

---

## 5. Horizontal Scaling & High Availability

1. **Competing Consumers**: BullMQ natively coordinates distributed job distribution across all running worker replicas. Adding instances automatically increases processing throughput without duplicate processing.
2. **Deterministic Deduplication**: Jobs are enqueued with deterministic IDs (`email-transactional-{deliveryId}`, `email-campaign-{recipientId}`). BullMQ rejects duplicate concurrent enqueues.
3. **Lock & Stalled Job Recovery**:
   - `lockDuration`: 30,000ms
   - `stalledInterval`: 15,000ms
   - `maxStalledCount`: 2
   - If a worker node is suddenly terminated (e.g., OOM kill, hardware fault), lingering locks are detected within 15–30 seconds and reclaimed by surviving workers.
4. **Cluster Discovery**:
   - Web API nodes inspect active workers via `getActiveWorkerHeartbeats(redis)`.
   - Health status reports `HEALTHY` when at least one active worker is publishing heartbeats.

---

## 6. Observability & Health Monitoring

### A. Health Endpoint
- **URL**: `GET /api/admin/email/queue/health`
- **Output**: JSON payload reporting Redis connectivity, PostgreSQL query latency, queue job counts (waiting, active, delayed, failed), dead-letter samples, and worker cluster heartbeats.

### B. Prometheus Metrics Endpoint
- **URL**: `GET /api/admin/email/queue/metrics?format=prometheus`
- **Content-Type**: `text/plain; version=0.0.4`
- **Exported Metrics**:
  - `email_worker_uptime_seconds`
  - `email_worker_active_jobs`
  - `email_jobs_total{status="succeeded|failed|stalled|skipped"}`
  - `email_job_duration_ms{type="average|last"}`
  - `email_queue_depth_jobs{queue="...",state="waiting|active|failed|delayed"}`
  - `email_backend_connected{service="redis|postgres"}`
  - `email_backend_latency_ms{service="redis|postgres"}`

---

## 7. Verification & Failure Simulation Test Suite

Run the full production worker test suite:
```bash
npm run test:email:worker
```

This verifies:
1. Startup validation (Redis + PostgreSQL)
2. URL and secret redaction in logs
3. Error classification (retryable 429/503/timeout vs permanent 401/400)
4. Monotonic delivery transaction state machine (no downgrade from SENT/DELIVERED)
5. Campaign safety (paused remains paused, cancelled remains cancelled, completed never resurrected)
6. Abandoned state reconciliation (stale PROCESSING deliveries reset to QUEUED or failed)
7. Heartbeat emission and clean deletion on shutdown
8. Health and Prometheus metrics reporting
9. Duplicate job protection via custom job IDs
