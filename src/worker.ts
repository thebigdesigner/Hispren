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
    default: console.warn("unknown job", job.name);
  }
}, { connection });

console.log("hispren worker up");
