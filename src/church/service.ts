/**
 * The church's own structure: groups, calendar, households, custom fields.
 * Everything a church configures about itself.
 */
import { Tx } from "../platform/db";
import { publish } from "../platform/outbox";
import { normaliseText } from "../members/service";

// ===========================================================================
// GROUPS — one recursive table holds every denomination's hierarchy
// ===========================================================================
export async function groupTree(tx: Tx) {
  const { rows } = await tx.query(`SELECT * FROM group_tree()`);
  return rows;
}

export async function getGroup(tx: Tx, id: string) {
  const { rows } = await tx.query(`
    SELECT g.*, t.path, t.depth, t.total_members, t.direct_members, t.leader_name,
      coalesce((SELECT json_agg(json_build_object(
        'id', p.id,
        'name', trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
        'phone', p.phone, 'role', gm.role, 'stage', js.label
      ) ORDER BY
        CASE gm.role WHEN 'leader' THEN 1 WHEN 'assistant_leader' THEN 2
                     WHEN 'worker' THEN 3 ELSE 4 END, p.last_name)
        FROM group_memberships gm
        JOIN persons p ON p.id = gm.person_id AND p.archived_at IS NULL
        LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
       WHERE gm.group_id = g.id AND gm.left_at IS NULL), '[]') AS members
    FROM groups g
    LEFT JOIN group_tree() t ON t.id = g.id
    WHERE g.id = $1`, [id]);
  return rows[0] ?? null;
}

export type GroupInput = {
  name: string;
  group_type: string;
  parent_id?: string | null;
  leader_id?: string | null;
  description?: string | null;
  meets_on?: string | null;
  meets_at?: string | null;
  meets_where?: string | null;
  area?: string | null;
  colour?: string;
};

export async function createGroup(tx: Tx, g: GroupInput) {
  const { rows } = await tx.query(
    `INSERT INTO groups (tenant_id, name, group_type, parent_id, leader_id,
                         description, meets_on, meets_at, meets_where, area, colour)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [normaliseText(g.name), g.group_type, g.parent_id || null, g.leader_id || null,
     normaliseText(g.description), g.meets_on || null, g.meets_at || null,
     normaliseText(g.meets_where), normaliseText(g.area), g.colour || '#4338CA']);
  await publish(tx, { type: "group.created", entityType: "group", entityId: rows[0].id });
  return rows[0];
}

export async function updateGroup(tx: Tx, id: string, g: Partial<GroupInput>) {
  const cols: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(g)) {
    if (!["name","group_type","parent_id","leader_id","description",
          "meets_on","meets_at","meets_where","area","colour"].includes(k)) continue;
    vals.push(typeof v === "string" ? normaliseText(v) : v);
    cols.push(`${k} = $${vals.length}`);
  }
  if (!cols.length) return getGroup(tx, id);
  // The cycle guard on `groups` will reject a parent that creates a loop.
  const { rows } = await tx.query(
    `UPDATE groups SET ${cols.join(", ")} WHERE id = $1 RETURNING id`, vals);
  return rows[0] ? getGroup(tx, id) : null;
}

/**
 * Archive, never delete. A group with fifteen years of attendance history
 * behind it must not vanish because someone clicked the wrong button.
 * Children are reparented to the grandparent, not orphaned.
 */
export async function archiveGroup(tx: Tx, id: string) {
  await tx.query(
    `UPDATE groups SET parent_id = (SELECT parent_id FROM groups WHERE id = $1)
      WHERE parent_id = $1`, [id]);
  await tx.query(`UPDATE persons SET home_group_id = NULL WHERE home_group_id = $1`, [id]);
  const { rows } = await tx.query(
    `UPDATE groups SET archived_at = now() WHERE id = $1 AND archived_at IS NULL
     RETURNING id`, [id]);
  return rows[0] ?? null;
}

export async function addToGroup(tx: Tx, groupId: string, personId: string, role = "member") {
  const { rows } = await tx.query(
    `INSERT INTO group_memberships (tenant_id, group_id, person_id, role)
     VALUES (current_tenant_id(), $1, $2, $3)
     ON CONFLICT (tenant_id, group_id, person_id) DO UPDATE SET role = $3, left_at = NULL
     RETURNING id`, [groupId, personId, role]);
  // If this is the person's only group, make it their home group too.
  await tx.query(
    `UPDATE persons SET home_group_id = $1 WHERE id = $2 AND home_group_id IS NULL`,
    [groupId, personId]);
  await publish(tx, { type: "group.member_added", entityType: "person",
    entityId: personId, payload: { group_id: groupId, role } });
  return rows[0];
}

export async function removeFromGroup(tx: Tx, groupId: string, personId: string) {
  await tx.query(
    `UPDATE group_memberships SET left_at = CURRENT_DATE
      WHERE group_id = $1 AND person_id = $2 AND left_at IS NULL`, [groupId, personId]);
  await tx.query(
    `UPDATE persons SET home_group_id = NULL WHERE id = $2 AND home_group_id = $1`,
    [groupId, personId]);
  return { removed: true };
}

// ===========================================================================
// CALENDAR — recurring services AND one-off events, one table
//   event_date IS NULL  -> it repeats (day_of_week)
//   event_date IS SET   -> it happens once
// ===========================================================================
export type ServiceInput = {
  name: string;
  kind: string;
  day_of_week?: number | null;
  event_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  location?: string | null;
  description?: string | null;
  colour?: string;
  expected?: number | null;
  group_id?: string | null;
};

export async function listCalendar(tx: Tx) {
  const { rows } = await tx.query(`
    SELECT s.*, g.name AS group_name,
      (SELECT count(*)::int FROM attendance_sessions x WHERE x.service_id = s.id) AS sessions_held,
      (SELECT max(x.session_date) FROM attendance_sessions x WHERE x.service_id = s.id) AS last_held
      FROM services s LEFT JOIN groups g ON g.id = s.group_id
     WHERE s.archived_at IS NULL
     ORDER BY (s.event_date IS NOT NULL), s.event_date, s.position, s.start_time`);
  return rows;
}

export async function createService(tx: Tx, s: ServiceInput) {
  if (s.day_of_week == null && !s.event_date)
    throw new Error("A service needs a weekday, or an event needs a date.");
  const { rows } = await tx.query(
    `INSERT INTO services (tenant_id, name, kind, day_of_week, event_date, start_time,
                           end_time, location, description, colour, expected, group_id, position)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             coalesce((SELECT max(position)+1 FROM services), 1))
     RETURNING *`,
    [normaliseText(s.name), s.kind, s.day_of_week ?? null, s.event_date || null,
     s.start_time || null, s.end_time || null, normaliseText(s.location),
     normaliseText(s.description), s.colour || '#4338CA', s.expected || null,
     s.group_id || null]);
  return rows[0];
}

export async function updateService(tx: Tx, id: string, s: Partial<ServiceInput>) {
  const cols: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(s)) {
    if (!["name","kind","day_of_week","event_date","start_time","end_time",
          "location","description","colour","expected","group_id"].includes(k)) continue;
    vals.push(v === "" ? null : v);
    cols.push(`${k} = $${vals.length}`);
  }
  if (!cols.length) return null;
  const { rows } = await tx.query(
    `UPDATE services SET ${cols.join(", ")} WHERE id = $1 RETURNING *`, vals);
  return rows[0] ?? null;
}

/** Archive. Attendance already recorded against it must survive. */
export async function archiveService(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `UPDATE services SET archived_at = now() WHERE id = $1 RETURNING id`, [id]);
  return rows[0] ?? null;
}

// ===========================================================================
// HOUSEHOLDS — churches think in families
// ===========================================================================
export async function listHouseholds(tx: Tx) {
  const { rows } = await tx.query(`
    SELECT h.id, h.name, h.address, h.area,
           (SELECT count(*)::int FROM persons p
             WHERE p.household_id = h.id AND p.archived_at IS NULL) AS members,
           (SELECT trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,''))
              FROM persons p WHERE p.household_id = h.id AND p.household_role = 'head'
              AND p.archived_at IS NULL LIMIT 1) AS head
      FROM households h WHERE h.archived_at IS NULL
     ORDER BY h.name`);
  return rows;
}

export async function addToHousehold(
  tx: Tx, householdId: string, personId: string, role: string
) {
  await tx.query(
    `UPDATE persons SET household_id = $1, household_role = $2 WHERE id = $3`,
    [householdId, role, personId]);
  return { added: true };
}

export async function removeFromHousehold(tx: Tx, personId: string) {
  await tx.query(
    `UPDATE persons SET household_id = NULL, household_role = NULL WHERE id = $1`,
    [personId]);
  return { removed: true };
}

// ===========================================================================
// CUSTOM FIELDS — where denomination lives.
//
// Pentecostal: born again, water baptism, Holy Ghost baptism, foundation school.
// Catholic:    baptismal name, confirmation name, sacraments.
// Neither belongs in the core schema. This is the line that keeps Hispren from
// being a product for exactly one denomination.
// ===========================================================================
export async function listFields(tx: Tx, entity = "person") {
  const { rows } = await tx.query(
    `SELECT id, entity, key, label, field_type, options, is_required, position
       FROM custom_property_definitions
      WHERE entity = $1 AND archived_at IS NULL ORDER BY position`, [entity]);
  return rows;
}

export async function createField(
  tx: Tx,
  f: { entity: string; label: string; field_type: string; options?: string[];
       is_required?: boolean }
) {
  const key = f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!key) throw new Error("That label cannot be turned into a field name.");
  const { rows } = await tx.query(
    `INSERT INTO custom_property_definitions
       (tenant_id, entity, key, label, field_type, options, is_required, position)
     VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,
             coalesce((SELECT max(position)+1 FROM custom_property_definitions
                        WHERE entity = $1), 1))
     ON CONFLICT (tenant_id, entity, key) DO UPDATE
       SET label = $3, field_type = $4, options = $5, archived_at = NULL
     RETURNING *`,
    [f.entity, key, normaliseText(f.label), f.field_type,
     f.options?.length ? JSON.stringify(f.options) : null, !!f.is_required]);
  return rows[0];
}

export async function archiveField(tx: Tx, id: string) {
  // Archive, never drop. The VALUES stay in persons.custom — a church that
  // turns a field off and back on again must not lose ten years of data.
  const { rows } = await tx.query(
    `UPDATE custom_property_definitions SET archived_at = now()
      WHERE id = $1 RETURNING id`, [id]);
  return rows[0] ?? null;
}

// ===========================================================================
// SETTINGS
// ===========================================================================
export async function getSettings(tx: Tx) {
  const { rows } = await tx.query(
    `SELECT id, name, subdomain, timezone, locale, brand_color, plan_tier,
            member_band, collects_health_data, status
       FROM tenants WHERE id = current_tenant_id()`);
  return rows[0] ?? null;
}

export async function updateSettings(
  tx: Tx, s: { name?: string; brand_color?: string; collects_health_data?: boolean }
) {
  const cols: string[] = [], vals: unknown[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (!["name","brand_color","collects_health_data"].includes(k)) continue;
    vals.push(typeof v === "string" ? normaliseText(v) : v);
    cols.push(`${k} = $${vals.length}`);
  }
  if (!cols.length) return getSettings(tx);
  const { rows } = await tx.query(
    `UPDATE tenants SET ${cols.join(", ")} WHERE id = current_tenant_id()
     RETURNING id, name, subdomain, brand_color, collects_health_data`, vals);
  return rows[0];
}
