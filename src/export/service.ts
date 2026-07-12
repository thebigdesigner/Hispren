/**
 * EXPORT.
 *
 * The church's data belongs to the church. Three reasons this exists:
 *
 *   1. NDPR data portability. It is not optional.
 *   2. Trust. In a market this suspicious of software vendors, "you can take
 *      your data out any time, in one click" closes deals.
 *   3. Churches will want to open it in Excel on Monday morning, because that
 *      is what they have always done.
 *
 * EVERY export writes an audit_log row. Someone downloading an entire
 * congregation's phone numbers is a security event, and it must leave a trace.
 */
import { Tx } from "../platform/db";

/**
 * RFC 4180 CSV escaping — and one Excel-specific defence.
 *
 * A cell starting with = + - @ is executed as a FORMULA by Excel. A member
 * named "=cmd|..." in an exported file becomes remote code execution on the
 * church secretary's laptop. Prefix those cells with a quote.
 */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;         // CSV injection guard
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csv(headers: string[], rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 correctly — Nigerian names have diacritics and
  // without this they arrive mangled and the church loses confidence instantly.
  return "\uFEFF" + [headers, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
}

async function audit(tx: Tx, userId: string, what: string, count: number) {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user, action, entity_type, after)
     VALUES (current_tenant_id(), $1, 'export', $2, $3)`,
    [userId, what, JSON.stringify({ rows: count })]);
}

// ---------------------------------------------------------------------------
// Members — the full record, minus health data.
// ---------------------------------------------------------------------------
export async function exportMembers(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query(`
    SELECT p.member_code, p.first_name, p.middle_name, p.last_name,
           p.gender, p.date_of_birth, p.marital_status,
           p.phone, p.phone_2, p.email,
           p.address, p.town, p.lga, p.state_of_origin, p.lga_of_origin,
           p.occupation, p.workplace, p.post_held,
           js.label AS stage, g.name AS group_name, p.usual_service,
           h.name AS household, p.household_role,
           p.source, p.joined_at, p.last_attended_at, p.created_at
      FROM persons p
      LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
      LEFT JOIN groups g          ON g.id  = p.home_group_id
      LEFT JOIN households h      ON h.id  = p.household_id
     WHERE p.archived_at IS NULL
     ORDER BY p.last_name NULLS LAST, p.first_name`);

  await audit(tx, userId, "members", rows.length);

  return csv(
    ["Member code","First name","Other name","Surname","Gender","Date of birth",
     "Marital status","Phone 1","Phone 2","Email","Address","Town","LGA",
     "State of origin","LGA of origin","Occupation","Workplace","Post held",
     "Stage","Group","Service","Household","Household role","Source",
     "Joined","Last attended","Registered"],
    rows.map(r => [
      r.member_code, r.first_name, r.middle_name, r.last_name, r.gender,
      r.date_of_birth, r.marital_status, r.phone, r.phone_2, r.email,
      r.address, r.town, r.lga, r.state_of_origin, r.lga_of_origin,
      r.occupation, r.workplace, r.post_held, r.stage, r.group_name,
      r.usual_service, r.household, r.household_role, r.source,
      r.joined_at, r.last_attended_at, r.created_at,
    ]));
}

// ---------------------------------------------------------------------------
// Attendance — one row per person per service.
//
// `recorded_at` is the DEVICE clock: when they were actually at the gate.
// `synced_at` is when the server found out, sometimes hours later. Both are
// exported, because a church being audited needs to know the difference.
// ---------------------------------------------------------------------------
export async function exportAttendance(
  tx: Tx, userId: string, from?: string, to?: string
): Promise<string> {
  const params: unknown[] = [];
  const w: string[] = [];
  if (from) { params.push(from); w.push(`s.session_date >= $${params.length}`); }
  if (to)   { params.push(to);   w.push(`s.session_date <= $${params.length}`); }

  const { rows } = await tx.query(`
    SELECT s.session_date, sv.name AS service,
           trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) AS name,
           p.member_code, p.phone,
           js.label AS stage, g.name AS group_name,
           a.method, a.recorded_at, a.synced_at, a.device_id
      FROM attendance a
      JOIN attendance_sessions s ON s.id = a.session_id
      JOIN services sv           ON sv.id = s.service_id
      JOIN persons p             ON p.id = a.person_id
      LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
      LEFT JOIN groups g          ON g.id = p.home_group_id
     ${w.length ? "WHERE " + w.join(" AND ") : ""}
     ORDER BY s.session_date DESC, sv.position, a.recorded_at`, params);

  await audit(tx, userId, "attendance", rows.length);

  return csv(
    ["Date","Service","Member","Member code","Phone","Stage","Group",
     "Method","At the gate","Synced","Device"],
    rows.map(r => [
      r.session_date, r.service, r.name, r.member_code, r.phone,
      r.stage, r.group_name, r.method, r.recorded_at, r.synced_at, r.device_id,
    ]));
}

// ---------------------------------------------------------------------------
// Attendance summary — one row per service per date. What a board wants.
// ---------------------------------------------------------------------------
export async function exportAttendanceSummary(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query(`
    SELECT s.session_date, sv.name AS service, s.status,
           (SELECT count(*) FROM attendance WHERE session_id = s.id) AS present,
           (SELECT count(*) FROM attendance a
              JOIN persons p2 ON p2.id = a.person_id
              JOIN journey_stages j2 ON j2.id = p2.journey_stage_id
             WHERE a.session_id = s.id AND j2.key IN ('visitor','first_timer')) AS first_timers,
           s.unregistered_count,
           (SELECT count(*) FROM attendance WHERE session_id = s.id)
             + s.unregistered_count AS total
      FROM attendance_sessions s JOIN services sv ON sv.id = s.service_id
     ORDER BY s.session_date DESC, sv.position`);

  await audit(tx, userId, "attendance_summary", rows.length);

  return csv(
    ["Date","Service","Status","Registered present","First timers",
     "Unregistered headcount","Total in the building"],
    rows.map(r => [r.session_date, r.service, r.status, r.present,
                   r.first_timers, r.unregistered_count, r.total]));
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
export async function exportGroups(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query(`
    WITH RECURSIVE tree AS (
      SELECT id, parent_id, name, group_type, 0 AS depth, name::text AS path
        FROM groups WHERE parent_id IS NULL AND archived_at IS NULL
      UNION ALL
      SELECT g.id, g.parent_id, g.name, g.group_type, t.depth + 1,
             t.path || ' > ' || g.name
        FROM groups g JOIN tree t ON g.parent_id = t.id
       WHERE g.archived_at IS NULL
    )
    SELECT t.path, t.name, t.group_type, t.depth,
           (SELECT count(*) FROM persons p WHERE p.home_group_id = t.id
              AND p.archived_at IS NULL) AS members
      FROM tree t ORDER BY t.path`);

  await audit(tx, userId, "groups", rows.length);
  return csv(["Full path","Name","Type","Level","Members"],
    rows.map(r => [r.path, r.name, r.group_type, r.depth, r.members]));
}

// ---------------------------------------------------------------------------
// Audit trail. A church board can ask who looked at what, and when.
// ---------------------------------------------------------------------------
export async function exportAudit(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query(`
    SELECT a.occurred_at, u.full_name AS who, u.email, a.action,
           a.entity_type, a.entity_id
      FROM audit_log a LEFT JOIN app_users u ON u.id = a.actor_user
     ORDER BY a.occurred_at DESC LIMIT 10000`);

  await audit(tx, userId, "audit_log", rows.length);
  return csv(["When","Who","Email","Action","Entity","Entity ID"],
    rows.map(r => [r.occurred_at, r.who, r.email, r.action, r.entity_type, r.entity_id]));
}
