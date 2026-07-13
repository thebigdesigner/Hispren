/**
 * THE IN-PROCESS WORKER.
 *
 * A message that is "queued" and never sent is worse than a message that fails,
 * because nobody knows. Every message Hispren has ever accepted is sitting in
 * the queue, because drainQueue() is only called by a worker process, and that
 * worker needs Redis, and Redis was never set up.
 *
 * So: stop needing Redis.
 *
 * At one church — or ten — a setInterval inside the API process is not a
 * compromise, it is the correct engineering. BullMQ buys you retries across
 * process restarts, back-pressure, and horizontal workers. None of those matter
 * until there is enough traffic to need them, and all of them cost an extra
 * service, an extra bill, and an extra thing that can be down on a Sunday
 * morning.
 *
 * When REDIS_URL IS set, this stands down and the real worker takes over.
 * The same functions run either way — only the scheduler differs.
 */
import { drainQueue, refreshDnd } from "../notify/service";
import { runBirthdays, runServiceReminders, runMissedAttendance } from "../notify/reminders";
import { runMeteringSnapshot, runRenewals, runDunningSweep } from "../billing/metering";
import { platformQuery } from "./db";

const SEND_EVERY = 15_000;        // drain the send queue
const HOUSEKEEP_EVERY = 60_000;   // check whether a daily job is due

/** Jobs that must run once a day, at a given hour, Africa/Lagos. */
const DAILY: Array<{ at: number; name: string; run: () => Promise<unknown> }> = [
  // 08:00 — inside the window MTN allows on the generic route.
  { at: 8,  name: "birthdays",        run: runBirthdays },
  // 15:00 the day BEFORE. NOT the evening: on the generic route MTN refuses
  // delivery 8pm-8am, so an evening reminder for tomorrow never arrives.
  { at: 15, name: "service reminder", run: runServiceReminders },
  // Monday morning, drafted for the pastor. Never auto-sent.
  { at: 9,  name: "missed attendance", run: () => runMissedAttendance(3) },
  // DND status changes rarely; checking costs an API call per number.
  { at: 1,  name: "dnd refresh",      run: () => refreshDnd(200) },
  { at: 2,  name: "billing metering", run: runMeteringSnapshot },
  { at: 3,  name: "sessions purge",   run: async () => {
      await platformQuery(`DELETE FROM sessions WHERE expires_at < now()`); } },
  { at: 4,  name: "billing dunning",  run: async () => {
      await runRenewals(); await runDunningSweep(); } },
];

const ranToday = new Map<string, string>();   // job -> YYYY-MM-DD
let draining = false;

function lagos() {
  const s = new Date().toLocaleString("en-GB", {
    timeZone: "Africa/Lagos", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  });
  // "13/07/2026, 15"
  const [d, h] = s.split(", ");
  const [dd, mm, yyyy] = d.split("/");
  return { day: `${yyyy}-${mm}-${dd}`, hour: Number(h) };
}

export function startInProcessWorker() {
  if (process.env.REDIS_URL) {
    console.log("REDIS_URL set — the separate worker owns the queue.");
    return;
  }
  console.log("no REDIS_URL — running the queue in-process. Correct below ~10 churches.");

  // ---- the send queue --------------------------------------------------
  // A message sitting in 'queued' forever is the worst failure mode there is:
  // the pastor believes it went, the member never got it, and nothing is logged
  // as an error because nothing errored.
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      const n = await drainQueue(50);
      if (n) console.log(`sent ${n} message(s)`);
    } catch (e: any) {
      console.error("send queue failed:", e.message);
    } finally {
      draining = false;
    }
  }, SEND_EVERY);

  // ---- daily jobs ------------------------------------------------------
  setInterval(async () => {
    const { day, hour } = lagos();
    for (const job of DAILY) {
      if (job.at !== hour) continue;
      if (ranToday.get(job.name) === day) continue;
      ranToday.set(job.name, day);
      try {
        console.log(`running: ${job.name}`);
        await job.run();
      } catch (e: any) {
        console.error(`${job.name} failed:`, e.message);
      }
    }
  }, HOUSEKEEP_EVERY);
}

/**
 * Drain the queue RIGHT NOW. Called immediately after a campaign is dispatched,
 * so a pastor who presses Send sees it go — rather than waiting up to fifteen
 * seconds and wondering whether it worked.
 */
export async function drainNow() {
  if (draining) return 0;
  draining = true;
  try { return await drainQueue(100); }
  catch { return 0; }
  finally { draining = false; }
}
