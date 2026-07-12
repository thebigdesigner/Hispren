/**
 * Member CRM — business logic.
 *
 * Every function takes a Tx from withTenant(). None of them can reach another
 * church's data even if the code is wrong — RLS is underneath. That is the
 * point of the whole Phase 0 exercise.
 */
import { Tx } from "../platform/db";
import { publish } from "../platform/outbox";

// ---------------------------------------------------------------------------
// Phone normalisation. Nigerian numbers arrive in five shapes:
//   08031234567 · 8031234567 · +2348031234567 · 2348031234567 · 0803 123 4567
// They must all become +2348031234567 or duplicate detection is worthless and
// SMS delivery fails silently.
// ---------------------------------------------------------------------------
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+234")) return d.length === 14 ? d : null;
  if (d.startsWith("234")) return "+" + d;
  if (d.startsWith("0") && d.length === 11) return "+234" + d.slice(1);
  if (d.length === 10) return "+234" + d;           // bare 8031234567
  return d.startsWith("+") ? d : null;              // foreign number, keep as-is
}

/**
 * Smart quotes and diacritics silently triple SMS cost: 160 GSM-7 chars per
 * unit becomes 70 UCS-2 chars the moment one non-GSM character appears.
 * Normalise on write. A Word-pasted apostrophe must never reach the gateway.
 */
export function normaliseText(s: string | null | undefined): string | null {
  if (!s) return null;
  return s
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .trim() || null;
}

export type MemberInput = {
  first_name: string;
  middle_name?: string | null;
  last_name?: string | null;
  gender?: "male" | "female" | null;
  date_of_birth?: string | null;
  marital_status?: string | null;
  phone?: string | null;
  phone_2?: string | null;
  email?: string | null;
  address?: string | null;
  town?: string | null;
  lga?: string | null;
  state_of_origin?: string | null;
  lga_of_origin?: string | null;
  occupation?: string | null;
  workplace?: string | null;
  post_held?: string | null;
  household_id?: string | null;
  household_role?: string | null;
  home_group_id?: string | null;
  usual_service?: string | null;
  journey_stage_id?: string | null;
  custom?: Record<string, unknown>;
  source?: string;
};

const FIELDS = [
  "first_name","middle_name","last_name","gender","date_of_birth","marital_status",
  "phone","phone_2","email","address","town","lga","state_of_origin","lga_of_origin",
  "occupation","workplace","post_held","household_id","household_role","home_group_id",
  "usual_service","journey_stage_id","custom","source",
] as const;

function clean(input: MemberInput): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (!(f in input)) continue;
    let v: unknown = (input as any)[f];
    if (f === "phone" || f === "phone_2") v = normalisePhone(v as string);
    else if (typeof v === "string") v = normaliseText(v);
    o[f] = v;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createMember(tx: Tx, input: MemberInput, actorId?: string) {
  const data = clean(input);
  if (!data.first_name) throw new Error("first_name is required");

  // Default to the tenant's first lifecycle stage if none given
  if (!data.journey_stage_id) {
    const s = await tx.query(
      `SELECT id FROM journey_stages ORDER BY position LIMIT 1`
    );
    data.journey_stage_id = s.rows[0]?.id ?? null;
  }

  const cols = Object.keys(data);
  const vals = Object.values(data);
  const ph = cols.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await tx.query(
    `INSERT INTO persons (tenant_id, ${cols.join(",")})
     VALUES (current_tenant_id(), ${ph}) RETURNING *`,
    vals
  );
  const person = rows[0];

  await tx.query(
    `INSERT INTO person_stage_history (tenant_id, person_id, to_stage_id, changed_by)
     VALUES (current_tenant_id(), $1, $2, $3)`,
    [person.id, person.journey_stage_id, actorId ?? null]
  );

  // Flag possible duplicates for HUMAN review. Never auto-merge.
  await queueDuplicates(tx, person.id);

  await publish(tx, {
    type: "member.registered",
    entityType: "person",
    entityId: person.id,
    payload: { source: person.source, stage_id: person.journey_stage_id },
  });
  return person;
}

// ---------------------------------------------------------------------------
// Update — with lifecycle-stage history and an event on stage change
// ---------------------------------------------------------------------------
export async function updateMember(tx: Tx, id: string, input: MemberInput, actorId?: string) {
  const before = await getMember(tx, id);
  if (!before) return null;

  const data = clean(input);
  if (!Object.keys(data).length) return before;

  const sets = Object.keys(data).map((c, i) => `${c} = $${i + 2}`).join(", ");
  const { rows } = await tx.query(
    `UPDATE persons SET ${sets} WHERE id = $1 RETURNING *`,
    [id, ...Object.values(data)]
  );
  const after = rows[0];
  if (!after) return null;

  if (data.journey_stage_id && data.journey_stage_id !== before.journey_stage_id) {
    await tx.query(
      `INSERT INTO person_stage_history (tenant_id, person_id, from_stage_id, to_stage_id, changed_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4)`,
      [id, before.journey_stage_id, data.journey_stage_id, actorId ?? null]
    );
    // The automation engine (Phase 2) listens for exactly this.
    await publish(tx, {
      type: "member.stage_changed",
      entityType: "person",
      entityId: id,
      payload: { from: before.journey_stage_id, to: data.journey_stage_id },
    });
  }
  if (data.phone || data.phone_2 || data.email) await queueDuplicates(tx, id);
  return after;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
export async function getMember(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `SELECT p.*,
            js.key AS stage_key, js.label AS stage_label,
            h.name AS household_name,
            g.name AS home_group_name,
            trim(coalesce(p.first_name,'') || ' ' || coalesce(p.middle_name,'')
                 || ' ' || coalesce(p.last_name,'')) AS full_name
       FROM persons p
       LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
       LEFT JOIN households     h  ON h.id  = p.household_id
       LEFT JOIN groups         g  ON g.id  = p.home_group_id
      WHERE p.id = $1 AND p.archived_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

export type MemberQuery = {
  q?: string;
  stage?: string;
  group_id?: string;
  service?: string;
  limit?: number;
  offset?: number;
};

export async function listMembers(tx: Tx, q: MemberQuery) {
  const where: string[] = ["p.archived_at IS NULL"];
  const params: unknown[] = [];

  if (q.q) {
    params.push(`%${q.q}%`, normalisePhone(q.q) ?? q.q);
    where.push(`(
      (coalesce(p.first_name,'')||' '||coalesce(p.middle_name,'')||' '||coalesce(p.last_name,''))
        ILIKE $${params.length - 1}
      OR p.phone = $${params.length} OR p.phone_2 = $${params.length}
      OR p.email ILIKE $${params.length - 1}
      OR p.member_code ILIKE $${params.length - 1})`);
  }
  if (q.stage)    { params.push(q.stage);    where.push(`js.key = $${params.length}`); }
  if (q.group_id) { params.push(q.group_id); where.push(`p.home_group_id = $${params.length}`); }
  if (q.service)  { params.push(q.service);  where.push(`p.usual_service = $${params.length}`); }

  const limit = Math.min(q.limit ?? 50, 200);
  params.push(limit, q.offset ?? 0);

  const { rows } = await tx.query(
    `SELECT p.id, p.first_name, p.middle_name, p.last_name, p.phone, p.phone_2,
            p.email, p.photo_url, p.member_code, p.usual_service, p.is_billable,
            js.key AS stage_key, js.label AS stage_label,
            g.name AS home_group_name,
            trim(coalesce(p.first_name,'')||' '||coalesce(p.middle_name,'')
                 ||' '||coalesce(p.last_name,'')) AS full_name,
            count(*) OVER () AS total_count
       FROM persons p
       LEFT JOIN journey_stages js ON js.id = p.journey_stage_id
       LEFT JOIN groups         g  ON g.id  = p.home_group_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.last_name NULLS LAST, p.first_name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    members: rows.map(({ total_count, ...m }) => m),
    total: rows[0] ? Number(rows[0].total_count) : 0,
  };
}

export async function archiveMember(tx: Tx, id: string) {
  // Soft delete. NDPR erasure is a separate, deliberate procedure — a church
  // admin clicking "delete" must never destroy a giving history.
  const { rows } = await tx.query(
    `UPDATE persons SET archived_at = now() WHERE id = $1 AND archived_at IS NULL
     RETURNING id`, [id]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// QR identity
//
// qr_token is separate from member_code on purpose: a QR screenshotted and
// shared in a WhatsApp group can be rotated without reprinting anyone's ID card.
// ---------------------------------------------------------------------------
export async function getQr(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `SELECT qr_token, member_code,
            trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) AS full_name
       FROM persons WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function rotateQr(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `UPDATE persons SET qr_token = gen_random_uuid() WHERE id = $1 RETURNING qr_token`,
    [id]);
  return rows[0] ?? null;
}

/** Scan lookup — used by the attendance scanner. Must be a single indexed hit. */
export async function findByQrToken(tx: Tx, token: string) {
  const { rows } = await tx.query(
    `SELECT id, first_name, last_name, photo_url, usual_service
       FROM persons WHERE qr_token = $1 AND archived_at IS NULL AND NOT is_deceased`,
    [token]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------
export async function createHousehold(tx: Tx, name: string, address?: string, area?: string) {
  const { rows } = await tx.query(
    `INSERT INTO households (tenant_id, name, address, area)
     VALUES (current_tenant_id(), $1, $2, $3) RETURNING *`,
    [normaliseText(name), normaliseText(address), normaliseText(area)]);
  return rows[0];
}

export async function getHousehold(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `SELECT h.*,
       coalesce(json_agg(json_build_object(
         'id', p.id, 'name', trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),
         'role', p.household_role, 'photo_url', p.photo_url,
         'date_of_birth', p.date_of_birth
       ) ORDER BY
         CASE p.household_role WHEN 'head' THEN 1 WHEN 'spouse' THEN 2
              WHEN 'child' THEN 3 ELSE 4 END,
         p.date_of_birth
       ) FILTER (WHERE p.id IS NOT NULL), '[]') AS members
     FROM households h
     LEFT JOIN persons p ON p.household_id = h.id AND p.archived_at IS NULL
     WHERE h.id = $1 GROUP BY h.id`, [id]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// HEALTH DATA — blood group + genotype
//
// Special-category under NDPR. Two hard rules:
//   1. Role-gated: pastor/admin only. Enforced in routes.ts.
//   2. EVERY read writes an audit_log row. No exceptions, no silent access.
//
// The pastoral value is real — genotype compatibility in marriage counselling,
// AS x AS carries a 1-in-4 sickle cell risk. The liability is equally real.
// ---------------------------------------------------------------------------
export async function getHealth(tx: Tx, personId: string, actorId: string) {
  const { rows } = await tx.query(
    `SELECT blood_group, genotype, consent_given, consent_at, updated_at
       FROM person_health WHERE person_id = $1`, [personId]);

  // Audit the READ, not just the write. Someone browsing genotypes leaves a trail.
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user, action, entity_type, entity_id)
     VALUES (current_tenant_id(), $1, 'health.read', 'person', $2)`,
    [actorId, personId]);

  return rows[0] ?? null;
}

export async function setHealth(
  tx: Tx, personId: string, actorId: string,
  d: { blood_group?: string | null; genotype?: string | null; consent_given: boolean }
) {
  const t = await tx.query(`SELECT collects_health_data FROM tenants WHERE id = current_tenant_id()`);
  if (!t.rows[0]?.collects_health_data) throw new Error("health_data_not_enabled");
  if (!d.consent_given) throw new Error("consent_required");

  const { rows } = await tx.query(
    `INSERT INTO person_health (person_id, tenant_id, blood_group, genotype,
                                consent_given, consent_at, recorded_by)
     VALUES ($1, current_tenant_id(), $2, $3, true, now(), $4)
     ON CONFLICT (person_id) DO UPDATE
       SET blood_group = $2, genotype = $3, consent_given = true,
           consent_at = now(), recorded_by = $4, updated_at = now()
     RETURNING *`,
    [personId, d.blood_group ?? null, d.genotype ?? null, actorId]);

  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user, action, entity_type, entity_id, after)
     VALUES (current_tenant_id(), $1, 'health.write', 'person', $2, $3)`,
    [actorId, personId, JSON.stringify({ genotype: d.genotype, blood_group: d.blood_group })]);

  return rows[0];
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------
export async function queueDuplicates(tx: Tx, personId: string, threshold = 0.6) {
  await tx.query(
    `INSERT INTO duplicate_candidates (tenant_id, person_a, person_b, score, reasons)
     SELECT current_tenant_id(), $1, d.candidate_id, d.score, d.reasons
       FROM find_duplicates($1) d
      WHERE d.score >= $2
     ON CONFLICT DO NOTHING`,
    [personId, threshold]);
}

export async function listDuplicates(tx: Tx, limit = 50) {
  const { rows } = await tx.query(
    `SELECT dc.id, dc.score, dc.reasons,
            json_build_object('id', a.id, 'name',
              trim(coalesce(a.first_name,'')||' '||coalesce(a.middle_name,'')||' '||coalesce(a.last_name,'')),
              'phone', a.phone, 'email', a.email, 'source', a.source,
              'created_at', a.created_at) AS person_a,
            json_build_object('id', b.id, 'name',
              trim(coalesce(b.first_name,'')||' '||coalesce(b.middle_name,'')||' '||coalesce(b.last_name,'')),
              'phone', b.phone, 'email', b.email, 'source', b.source,
              'created_at', b.created_at) AS person_b
       FROM duplicate_candidates dc
       JOIN persons a ON a.id = dc.person_a
       JOIN persons b ON b.id = dc.person_b
      WHERE dc.status = 'open' AND a.archived_at IS NULL AND b.archived_at IS NULL
      ORDER BY dc.score DESC LIMIT $1`, [limit]);
  return rows;
}

/**
 * Merge. Destroys a record — so it is never automatic, and always reversible
 * in principle: the losing record is snapshotted verbatim into merge_log first.
 *
 * `keep` wins on conflicts, but empty fields on `keep` are filled from `merge`.
 * A visitor card with only a phone number should enrich the full record, not
 * be thrown away.
 */
export async function mergeMembers(tx: Tx, keepId: string, mergeId: string, actorId: string) {
  if (keepId === mergeId) throw new Error("cannot merge a record into itself");

  const snap = await tx.query(`SELECT * FROM persons WHERE id = $1`, [mergeId]);
  if (!snap.rows[0]) throw new Error("record not found");

  await tx.query(
    `INSERT INTO merge_log (tenant_id, kept_id, merged_id, merged_snapshot, merged_by)
     VALUES (current_tenant_id(), $1, $2, $3, $4)`,
    [keepId, mergeId, JSON.stringify(snap.rows[0]), actorId]);

  // Backfill: keep wins, but never lose data that only the loser had.
  await tx.query(
    `UPDATE persons k SET
       middle_name     = coalesce(k.middle_name, m.middle_name),
       last_name       = coalesce(k.last_name, m.last_name),
       phone           = coalesce(k.phone, m.phone),
       phone_2         = coalesce(k.phone_2, m.phone_2,
                          CASE WHEN m.phone <> k.phone THEN m.phone END),
       email           = coalesce(k.email, m.email),
       date_of_birth   = coalesce(k.date_of_birth, m.date_of_birth),
       address         = coalesce(k.address, m.address),
       town            = coalesce(k.town, m.town),
       lga             = coalesce(k.lga, m.lga),
       state_of_origin = coalesce(k.state_of_origin, m.state_of_origin),
       lga_of_origin   = coalesce(k.lga_of_origin, m.lga_of_origin),
       occupation      = coalesce(k.occupation, m.occupation),
       workplace       = coalesce(k.workplace, m.workplace),
       photo_url       = coalesce(k.photo_url, m.photo_url),
       household_id    = coalesce(k.household_id, m.household_id),
       home_group_id   = coalesce(k.home_group_id, m.home_group_id),
       custom          = m.custom || k.custom
     FROM persons m WHERE k.id = $1 AND m.id = $2`,
    [keepId, mergeId]);

  // Move relationships. Attendance, tasks, giving must follow the surviving record.
  await tx.query(
    `UPDATE group_memberships gm SET person_id = $1 WHERE person_id = $2
       AND NOT EXISTS (SELECT 1 FROM group_memberships x
                        WHERE x.person_id = $1 AND x.group_id = gm.group_id)`,
    [keepId, mergeId]);
  await tx.query(`DELETE FROM group_memberships WHERE person_id = $1`, [mergeId]);
  await tx.query(`UPDATE person_milestones SET person_id = $1 WHERE person_id = $2`, [keepId, mergeId]);
  await tx.query(`UPDATE care_requests     SET person_id = $1 WHERE person_id = $2`, [keepId, mergeId]);
  await tx.query(`UPDATE tasks SET assigned_to_person = $1 WHERE assigned_to_person = $2`, [keepId, mergeId]);

  await tx.query(`UPDATE persons SET archived_at = now() WHERE id = $1`, [mergeId]);
  await tx.query(
    `UPDATE duplicate_candidates SET status = 'merged', resolved_by = $3, resolved_at = now()
      WHERE (person_a = $1 AND person_b = $2) OR (person_a = $2 AND person_b = $1)`,
    [keepId, mergeId, actorId]);

  await publish(tx, {
    type: "member.merged", entityType: "person", entityId: keepId,
    payload: { merged_id: mergeId },
  });
  return getMember(tx, keepId);
}

export async function dismissDuplicate(tx: Tx, id: string, actorId: string) {
  const { rows } = await tx.query(
    `UPDATE duplicate_candidates
        SET status = 'dismissed', resolved_by = $2, resolved_at = now()
      WHERE id = $1 RETURNING id`, [id, actorId]);
  return rows[0] ?? null;
}


// ---------------------------------------------------------------------------
// Lookups for the edit form
// ---------------------------------------------------------------------------
export async function listStages(tx: Tx) {
  const { rows } = await tx.query(
    `SELECT id, key, label, position FROM journey_stages ORDER BY position`);
  return rows;
}

/** The recursive hierarchy, flattened with an indent so a <select> can show it. */
export async function listGroups(tx: Tx) {
  const { rows } = await tx.query(`
    WITH RECURSIVE tree AS (
      SELECT id, parent_id, name, group_type, 0 AS depth, name::text AS path
        FROM groups WHERE parent_id IS NULL AND archived_at IS NULL
      UNION ALL
      SELECT g.id, g.parent_id, g.name, g.group_type, t.depth + 1,
             t.path || ' / ' || g.name
        FROM groups g JOIN tree t ON g.parent_id = t.id
       WHERE g.archived_at IS NULL
    )
    SELECT id, name, group_type, depth, path,
           (SELECT count(*)::int FROM persons p
             WHERE p.home_group_id = tree.id AND p.archived_at IS NULL) AS members
      FROM tree ORDER BY path`);
  return rows;
}

export async function listStates(tx: Tx) {
  const { rows } = await tx.query(`SELECT code, name FROM ng_states ORDER BY name`);
  return rows;
}
