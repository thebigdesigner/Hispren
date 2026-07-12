/**
 * WORKER.
 *
 * A separate process from the API. It needs Redis; the API does not.
 * On Railway this is a second service with start command:  npx tsx src/worker.ts
 *
 * Three jobs:
 *   1. Relay the transactional outbox into the queue.
 *   2. Drain the SMS send queue.
 *   3. Run the reminders — which are cron jobs, not AI.
 */
import { Worker, ConnectionOptions } from "bullmq";
import { startOutboxRelay, registerSchedules } from "./platform/queue";
import { runMeteringSnapshot, runRenewals, runDunningSweep } from "./billing/metering";
import { platformQuery } from "./platform/db";
import { drainQueue, refreshDnd } from "./notify/service";
import { runBirthdays, runServiceReminders, runMissedAttendance } from "./notify/reminders";

const connection: ConnectionOptions = {
  url: process.env.REDIS_URL!,
  maxRetriesPerRequest: null,
} as ConnectionOptions;

startOutboxRelay();
registerSchedules();

new Worker("jobs", async (job) => {
  switch (job.name) {
    // ---- billing ----
    case "billing.metering.snapshot":
      return runMeteringSnapshot();
    case "billing.dunning.sweep":
      await runRenewals();
      return runDunningSweep();
    case "sessions.purge":
      await platformQuery(`DELETE FROM sessions WHERE expires_at < now()`);
      return;

    // ---- notifications ----
    // The send queue. Every 30 seconds.
    case "notify.drain":
      await drainQueue(50);
      return;
    // Cached DND status. Checking costs an API call per number, so this runs
    // nightly for numbers we have never checked or have not checked in a month.
    case "notify.dnd":
      await refreshDnd(200);
      return;

    // ---- reminders: cron, not AI ----
    // A birthday is a WHERE clause and a date. Routing it through an LLM would
    // mean paying tokens for a database query and introducing hallucination
    // into a feature that must never fail.
    case "reminders.birthdays":
      return runBirthdays();
    case "reminders.service":
      return runServiceReminders();
    case "reminders.missed":
      // Drafted for the pastor, never auto-sent. A "we missed you" text to
      // someone whose mother just died is worse than silence.
      return runMissedAttendance(3);

    default:
      console.warn("unknown job:", job.name);
  }
}, { connection });

console.log("hispren worker up");
