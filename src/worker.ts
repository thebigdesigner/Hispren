/**
 * Worker. Needs Redis + bullmq (optionalDependencies).
 * Run it as a SEPARATE Railway service with its own start command:
 *   npx tsx src/worker.ts
 * The API image does not ship these packages.
 */
/** Worker process: outbox relay + scheduled jobs. Needs Redis. The API does not. */
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { startOutboxRelay, registerSchedules } from "./platform/queue";
import { runMeteringSnapshot, runRenewals, runDunningSweep } from "./billing/metering";
import { platformQuery } from "./platform/db";
import { birthdayReminders, serviceReminders, missedAttendanceReminders, followUpTasks }
  from "./notify/reminders";
import { deliver } from "./notify/service";
import { onEvent } from "./platform/queue";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

startOutboxRelay();
registerSchedules();

new Worker("jobs", async (job) => {
  switch (job.name) {
    case "billing.metering.snapshot": return runMeteringSnapshot();
    case "billing.dunning.sweep":     await runRenewals(); return runDunningSweep();
    case "sessions.purge":
      await platformQuery(`DELETE FROM sessions WHERE expires_at < now()`);
      return;
    case "reminders.birthday":  return birthdayReminders();
    case "reminders.service":   return serviceReminders();
    case "reminders.missed":    return missedAttendanceReminders(3);
    case "reminders.followups": return followUpTasks();
    default: console.warn("unknown job", job.name);
  }
}, { connection });

console.log("hispren worker up");


// Deliver queued messages. The API composes and debits; the worker sends.
onEvent(async (name, data) => {
  if (name === "message.queued" && data?.entityId) {
    await deliver(data.entityId).catch((e) => console.error("deliver failed", e.message));
  }
});
