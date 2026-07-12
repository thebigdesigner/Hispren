/**
 * The Redis half of the event bus. ONLY the worker process imports this.
 * The API never does — which is why the API boots without Redis.
 */
import { Queue, Worker, JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { platformQuery } from "./db";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

export const eventsQueue = new Queue("events", { connection });
export const jobsQueue = new Queue("jobs", { connection });

/** Poll unpublished outbox rows -> enqueue -> mark published. */
export function startOutboxRelay(intervalMs = 500): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await platformQuery<any>(
        `SELECT id, tenant_id, event_type, entity_type, entity_id, payload
           FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`
      );
      for (const e of rows) {
        await eventsQueue.add(
          e.event_type,
          { tenantId: e.tenant_id, entityType: e.entity_type,
            entityId: e.entity_id, payload: e.payload, outboxId: e.id },
          { jobId: `outbox:${e.id}` }   // idempotent: a re-relay cannot duplicate
        );
        await platformQuery(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [e.id]);
      }
    } finally { running = false; }
  }, intervalMs);
}

export function onEvent(handler: (name: string, data: any) => Promise<void>): Worker {
  return new Worker("events", async (job) => handler(job.name, job.data), {
    connection, concurrency: 10,
  });
}

export async function registerSchedules(): Promise<void> {
  const daily = (h: number, m = 0): JobsOptions =>
    ({ repeat: { pattern: `${m} ${h} * * *`, tz: "Africa/Lagos" } });
  await jobsQueue.add("billing.metering.snapshot", {}, daily(2));
  await jobsQueue.add("billing.dunning.sweep", {}, daily(8));
  await jobsQueue.add("sessions.purge", {}, daily(3));
}
