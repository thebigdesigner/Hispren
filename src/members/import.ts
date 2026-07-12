/**
 * Bulk import.
 *
 * Churches arrive with a decade of Excel: inconsistent headers, "08031234567"
 * stored as a number with the leading zero eaten, dates as "14/03/01", empty
 * rows, and the same person entered three times. This is the onboarding fee
 * made of code.
 *
 * Two-phase on purpose: PREVIEW then COMMIT. An import that silently mangles
 * 2,000 records is a church that never trusts you again.
 */
import { Tx } from "../platform/db";
import { normalisePhone, normaliseText, createMember, MemberInput } from "./service";

/** Header guesses. Real church spreadsheets use all of these. */
const ALIASES: Record<string, string[]> = {
  first_name:      ["first name","firstname","name","given name","surname first","fname"],
  middle_name:     ["middle name","other name","other names","middlename","onames"],
  last_name:       ["last name","surname","lastname","family name","sname"],
  gender:          ["gender","sex"],
  date_of_birth:   ["date of birth","dob","birthday","birth date"],
  marital_status:  ["marital status","marital","status"],
  phone:           ["phone","phone number","phone number (1)","mobile","gsm","tel","phone 1"],
  phone_2:         ["phone 2","phone number (2)","alt phone","other phone","second phone"],
  email:           ["email","e-mail","email address"],
  address:         ["address","residential address","home address"],
  town:            ["town","city"],
  lga:             ["lga","local government","l.g.a"],
  state_of_origin: ["state of origin","state","origin"],
  lga_of_origin:   ["lga of origin","origin lga"],
  occupation:      ["occupation","work","work/school","job","profession"],
  workplace:       ["place of work","workplace","place of work/school","employer","school"],
  post_held:       ["post held","office","position","role"],
  usual_service:   ["service","usual service","which service"],
};

export function guessColumnMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const key = h.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(key) && !Object.values(map).includes(field)) {
        map[h] = field;
        break;
      }
    }
  }
  return map;
}

/**
 * Excel eats leading zeros: 08031234567 becomes the number 8031234567.
 * Excel also renders dates however the machine's locale felt that day.
 */
function parseDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;                       // ISO
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);    // DD/MM/YYYY (NG default)
  if (m) {
    let [, d, mo, y] = m;
    let yy = Number(y);
    if (y.length === 2) yy = yy > 30 ? 1900 + yy : 2000 + yy;
    const dd = Number(d), mm = Number(mo);
    if (dd > 31 || mm > 12) return null;
    return `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export type RowResult = {
  row: number;
  data?: MemberInput;
  errors: string[];
  warnings: string[];
};

export function validateRows(
  rows: Record<string, string>[],
  map: Record<string, string>
): RowResult[] {
  return rows.map((raw, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const d: any = { source: "bulk_import" };

    for (const [header, field] of Object.entries(map)) {
      const v = (raw[header] ?? "").toString().trim();
      if (!v) continue;

      if (field === "phone" || field === "phone_2") {
        const p = normalisePhone(v);
        if (!p) warnings.push(`${field}: "${v}" is not a valid Nigerian number — dropped`);
        else d[field] = p;
      } else if (field === "date_of_birth") {
        const dt = parseDate(v);
        if (!dt) warnings.push(`date of birth: "${v}" could not be read — dropped`);
        else d[field] = dt;
      } else if (field === "gender") {
        const g = v.toLowerCase()[0];
        if (g === "m") d.gender = "male";
        else if (g === "f") d.gender = "female";
        else warnings.push(`gender: "${v}" not recognised — dropped`);
      } else {
        d[field] = normaliseText(v);
      }
    }

    // Split a single "Name" column: "Okonkwo Chinedu Emeka"
    if (d.first_name && !d.last_name && d.first_name.includes(" ")) {
      const parts = d.first_name.split(/\s+/);
      d.first_name = parts[0];
      if (parts.length === 2) d.last_name = parts[1];
      else { d.middle_name = parts.slice(1, -1).join(" "); d.last_name = parts.at(-1); }
      warnings.push(`name was split into parts — check it is right`);
    }

    if (!d.first_name) errors.push("no name found in this row");
    if (!d.phone && !d.phone_2 && !d.email)
      warnings.push("no phone or email — this member cannot be contacted");

    return { row: i + 2, data: errors.length ? undefined : d, errors, warnings };
  });
}

export async function commitImport(
  tx: Tx, batchId: string, results: RowResult[], actorId: string
) {
  let imported = 0;
  for (const r of results) {
    if (!r.data) continue;
    const p = await createMember(tx, r.data, actorId);
    await tx.query(`UPDATE persons SET import_batch_id = $1 WHERE id = $2`, [batchId, p.id]);
    imported++;
  }
  await tx.query(
    `UPDATE import_batches SET status = 'committed', imported_rows = $2, committed_at = now()
      WHERE id = $1`, [batchId, imported]);
  return imported;
}

/** A bad import must be undoable. Archive everything the batch created. */
export async function revertImport(tx: Tx, batchId: string) {
  const { rows } = await tx.query(
    `UPDATE persons SET archived_at = now()
      WHERE import_batch_id = $1 AND archived_at IS NULL RETURNING id`, [batchId]);
  await tx.query(`UPDATE import_batches SET status = 'reverted' WHERE id = $1`, [batchId]);
  return rows.length;
}
