/**
 * Event bus = transactional outbox + queue relay.
 *
 * WHY: if a module writes data and then publishes to Redis separately, a crash
 * between the two loses the event — and in Phase 2 a lost event is a first-
 * timer who never gets followed up. The outbox INSERT rides the SAME
 * transaction as the data change; the relay ships it afterwards.
 *
 * Modules call publish(tx, ...) inside withTenant(). They never touch Redis.
 */
import { Queue, Worker, JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { Tx, platformQuery } from "./db";

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const eventsQueue = new Queue("events", { connection });
export const jobsQueue = new Queue("jobs", { connection });

/** Publish an event inside the caller's tenant transaction. */
export async function publish(
  tx: Tx,
  event: {
    type: string;          // 'visitor.registered'
    entityType: string;    // 'person'
    entityId?: string;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO event_outbox (tenant_id, event_type, entity_type, entity_id, payload)
     VALUES (current_tenant_id(), $1, $2, $3, $4)`,
    [event.type, event.entityType, event.entityId ?? null, event.payload ?? {}]
  );
}

/**
 * Relay: poll unpublished outbox rows → enqueue → mark published.
 * Runs in the worker process. Uses platformQuery (crosses tenants by design;
 * rows carry their tenant_id with them).
 */
export function startOutboxRelay(intervalMs = 500): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await platformQuery<{
        id: string; tenant_id: string; event_type: string;
        entity_type: string; entity_id: string | null; payload: any;
      }>(
        `SELECT id, tenant_id, event_type, entity_type, entity_id, payload
           FROM event_outbox WHERE published_at IS NULL
          ORDER BY id LIMIT 100`
      );
      for (const e of rows) {
        await eventsQueue.add(
          e.event_type,
          { tenantId: e.tenant_id, entityType: e.entity_type,
            entityId: e.entity_id, payload: e.payload, outboxId: e.id },
          { jobId: `outbox:${e.id}` } // idempotency: re-relay can't duplicate
        );
        await platformQuery(
          `UPDATE event_outbox SET published_at = now() WHERE id = $1`, [e.id]
        );
      }
    } finally {
      running = false;
    }
  }, intervalMs);
}

/** Consumer registration — Phase 2's automation engine plugs in here. */
export function onEvent(
  handler: (name: string, data: any) => Promise<void>
): Worker {
  return new Worker("events", async (job) => handler(job.name, job.data), {
    connection,
    concurrency: 10,
  });
}

// ---------------------------------------------------------------------------
// Scheduled jobs (BullMQ repeatables). Handlers live in their modules.
// ---------------------------------------------------------------------------
export async function registerSchedules(): Promise<void> {
  const daily = (h: number, m = 0): JobsOptions => ({
    repeat: { pattern: `${m} ${h} * * *`, tz: "Africa/Lagos" },
  });
  await jobsQueue.add("billing.metering.snapshot", {}, daily(2));     // 02:00 WAT
  await jobsQueue.add("billing.dunning.sweep", {}, daily(8));        // inside business hours
  await jobsQueue.add("sessions.purge", {}, daily(3));
  await jobsQueue.add("persons.billable.derive", {}, daily(2, 30));
  // Phase 2 adds: activity_summary.materialise, absence.evaluate, date.triggers
}
