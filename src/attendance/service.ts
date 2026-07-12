/**
 * Attendance.
 *
 * The scanner is OFFLINE. Everything here assumes scans arrive late, out of
 * order, and sometimes twice. None of that is an error condition — it is the
 * normal case at a Nigerian church gate.
 */
import { Tx } from "../platform/db";
import { publish } from "../platform/outbox";

export async function listServices(tx: Tx) {
  const { rows } = await tx.query(
    `SELECT id, name, kind, day_of_week, start_time
       FROM services WHERE archived_at IS NULL ORDER BY position`);
  return rows;
}

/** Open a session, or return today's if an usher already opened it. */
export async function openSession(tx: Tx, serviceId: string, date: string, userId: string) {
  const { rows } = await tx.query(
    `INSERT INTO attendance_sessions (tenant_id, service_id, session_date, opened_by)
     VALUES (current_tenant_id(), $1, $2, $3)
     ON CONFLICT (tenant_id, service_id, session_date) DO UPDATE
       SET status = 'open'
     RETURNING *`,
    [serviceId, date, userId]);
  return rows[0];
}

export async function closeSession(tx: Tx, id: string, unregistered = 0) {
  const { rows } = await tx.query(
    `UPDATE attendance_sessions
        SET status='closed', closed_at=now(), unregistered_count=$2
      WHERE id=$1 RETURNING *`, [id, unregistered]);
  if (rows[0]) {
    await publish(tx, {
      type: "attendance.session_closed",
      entityType: "attendance_session",
      entityId: id,
      payload: { date: rows[0].session_date, service_id: rows[0].service_id },
    });
  }
  return rows[0] ?? null;
}

/**
 * The roster the phone caches before going offline.
 *
 * Deliberately minimal: qr_token, id, name, service. NOT the address, NOT the
 * phone, NOT the genotype. An usher's phone gets lost. It must not contain a
 * congregation's personal data.
 */
export async function roster(tx: Tx) {
  const { rows } = await tx.query(`SELECT * FROM roster_snapshot()`);
  return rows;
}

export type Scan = {
  person_id: string;
  recorded_at: string;   // DEVICE clock — when they were actually at the gate
  method?: "qr" | "manual";
  device_id?: string;
};

/**
 * Flush a queue of offline scans.
 *
 * ON CONFLICT DO NOTHING is the entire conflict-resolution strategy, and it is
 * the right one: the FIRST scan wins, because that is when the person arrived.
 * Last-write-wins would move their arrival time later every time an usher
 * fumbled the phone.
 */
export async function syncScans(tx: Tx, sessionId: string, scans: Scan[], userId: string) {
  if (!scans.length) return { accepted: 0, duplicates: 0 };

  const vals: unknown[] = [];
  const rows = scans.map((s, i) => {
    const o = i * 5;
    vals.push(sessionId, s.person_id, s.method ?? "qr", s.recorded_at, s.device_id ?? null);
    return `(current_tenant_id(), $${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5}, '${userId}')`;
  }).join(",");

  const { rows: inserted } = await tx.query(
    `INSERT INTO attendance
       (tenant_id, session_id, person_id, method, recorded_at, device_id, recorded_by)
     VALUES ${rows}
     ON CONFLICT (session_id, person_id) DO NOTHING
     RETURNING person_id`,
    vals);

  for (const r of inserted) {
    await publish(tx, {
      type: "attendance.recorded",
      entityType: "person",
      entityId: r.person_id,
      payload: { session_id: sessionId },
    });
  }
  return { accepted: inserted.length, duplicates: scans.length - inserted.length };
}

export async function sessionState(tx: Tx, sessionId: string) {
  const { rows } = await tx.query(
    `SELECT s.*, sv.name AS service_name,
            (SELECT count(*)::int FROM attendance WHERE session_id = s.id) AS present,
            (SELECT count(*)::int FROM attendance a
               JOIN persons p ON p.id = a.person_id
               JOIN journey_stages js ON js.id = p.journey_stage_id
              WHERE a.session_id = s.id AND js.key IN ('visitor','first_timer')) AS first_timers
       FROM attendance_sessions s JOIN services sv ON sv.id = s.service_id
      WHERE s.id = $1`, [sessionId]);
  return rows[0] ?? null;
}

export async function byService(tx: Tx, date: string) {
  const { rows } = await tx.query(`SELECT * FROM attendance_by_service($1)`, [date]);
  return rows;
}

/** Who was present, most recent first. Powers the live list on the scanner. */
export async function present(tx: Tx, sessionId: string, limit = 50) {
  const { rows } = await tx.query(
    `SELECT a.person_id, a.recorded_at, a.method,
            trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
            js.key AS stage_key, js.label AS stage_label
       FROM attendance a
       JOIN persons p ON p.id = a.person_id
       LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
      WHERE a.session_id = $1
      ORDER BY a.recorded_at DESC LIMIT $2`, [sessionId, limit]);
  return rows;
}
