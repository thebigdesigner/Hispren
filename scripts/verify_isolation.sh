#!/usr/bin/env bash
# Pure-SQL isolation check. Needs only psql — no npm, no vitest.
#   ./scripts/verify_isolation.sh "$MIGRATION_DATABASE_URL" "$DATABASE_URL"
set -u
OWNER_URL="$1"; APP_URL="$2"
A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222

psql "$OWNER_URL" -q -c "INSERT INTO tenants (id,name,subdomain) VALUES
 ('$A','Iso A','iso-a'),('$B','Iso B','iso-b') ON CONFLICT DO NOTHING;" 2>/dev/null
PID=$(psql "$OWNER_URL" -tAc "INSERT INTO persons (tenant_id,first_name,last_name,date_of_birth)
 VALUES ('$A','Amaka','Okafor','1990-03-14') RETURNING id;")

fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fail=1; fi; }

echo "TWO-TENANT ISOLATION"
chk "B cannot list A's persons" \
  "$(psql "$APP_URL" -tAc "BEGIN; SET LOCAL app.tenant_id='$B'; SELECT count(*) FROM persons; COMMIT;" | grep -E '^[0-9]+$')" "0"
chk "B cannot fetch A's person by PK" \
  "$(psql "$APP_URL" -tAc "BEGIN; SET LOCAL app.tenant_id='$B'; SELECT count(*) FROM persons WHERE id='$PID'; COMMIT;" | grep -E '^[0-9]+$')" "0"
chk "B cannot UPDATE A's person" \
  "$(psql "$APP_URL" -tAc "BEGIN; SET LOCAL app.tenant_id='$B'; UPDATE persons SET first_name='Hacked' WHERE id='$PID'; COMMIT;" 2>&1 | grep -oE 'UPDATE [0-9]+')" "UPDATE 0"
chk "no tenant context returns 0 rows (fail-closed)" \
  "$(psql "$APP_URL" -tAc "SELECT count(*) FROM persons;" | grep -E '^[0-9]+$')" "0"
chk "app role is NOT the table owner" \
  "$(psql "$APP_URL" -tAc "SELECT current_user = (SELECT tableowner FROM pg_tables WHERE tablename='persons');")" "f"
chk "all tenant tables have RLS enabled+forced" \
  "$(psql "$OWNER_URL" -tAc "SELECT count(*) FROM pg_class WHERE relname IN
     ('persons','households','groups','tasks','care_requests','segments','consents',
      'event_outbox','files') AND (NOT relrowsecurity OR NOT relforcerowsecurity);")" "0"

psql "$OWNER_URL" -q -c "DELETE FROM tenants WHERE id IN ('$A','$B');" 2>/dev/null
echo ""
[ $fail -eq 0 ] && echo "ALL GREEN — tenant isolation verified" || { echo "SUITE FAILED — do not ship"; exit 1; }
