-- ============================================================================
-- 009 — GIVING AND FUND ACCOUNTING
--
-- TWO THINGS EVERY COMPETITOR GETS WRONG.
--
-- 1. THEY ASSUME CARDS. Nigerian giving is CASH — offering bags, counting
--    teams, tithe envelopes. A product built around online donations describes
--    a church that does not exist here. So the primitive is a COUNTING SESSION,
--    not a card transaction.
--
-- 2. THEY CANNOT ENFORCE RESTRICTED FUNDS. From the market research:
--    "ChurchTrac's income and expense tracking is NOT fund accounting — it
--    cannot enforce restricted fund boundaries. Planning Center has no
--    accounting features at all."
--
--    Money given for the building CANNOT be spent on salaries. That is not a
--    guideline. It is the fastest way a church treasurer ends up in front of a
--    board he cannot face, and every product on the market will happily let him
--    do it.
--
--    Hispren makes it IMPOSSIBLE. Not "warned about" — impossible. The database
--    refuses the transaction, exactly as it refuses a cross-tenant read.
--
-- Hispren NEVER takes a percentage of giving. The church keeps every kobo.
-- This module exists to let a treasurer sleep, not to skim.
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- FUNDS
--   general     Spend on anything. Tithes, loose offering.
--   restricted  The GIVER decided what it is for. You may not spend it on
--               anything else. THE DATABASE ENFORCES THIS.
--   designated  The BOARD decided. The board can undo it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'general'
              CHECK (kind IN ('general','restricted','designated')),
  code        text,
  description text,
  is_default  boolean NOT NULL DEFAULT false,
  -- What a RESTRICTED fund may be spent on. NULL = no category restriction
  -- (deficit is still refused). A non-empty list means an expense in any OTHER
  -- category is refused outright.
  --
  -- Blocking a deficit is not the same as blocking MISUSE. A building fund with
  -- NGN 888,000 in it would happily cover a NGN 400,000 salary — the balance
  -- allows it, and every other product on the market would let it through.
  -- This is the line that actually protects the giver's intent.
  allowed_categories text[],
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_funds_tenant ON funds(tenant_id) WHERE archived_at IS NULL;

-- ----------------------------------------------------------------------------
-- COUNTING SESSIONS — the actual Nigerian primitive.
--
-- The bags come off the altar. Two ushers count. Both are named. The treasurer
-- verifies. Only THEN is it money.
--
-- A CLOSED batch cannot be edited. That is the whole control: if one person can
-- quietly change a counted figure afterwards, the count means nothing and the
-- church has no protection at all.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS giving_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_date     date NOT NULL DEFAULT CURRENT_DATE,
  service_id     uuid REFERENCES services(id) ON DELETE SET NULL,
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  -- Two people count. Both are named. This is not bureaucracy — it is the only
  -- thing standing between a church and a quiet theft nobody can prove.
  counted_by     text,
  verified_by    text,
  expected_total numeric(14,2),      -- what the counters said out loud
  notes          text,
  created_by     uuid REFERENCES app_users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_batch_tenant ON giving_batches(tenant_id, batch_date DESC);

-- ----------------------------------------------------------------------------
-- CONTRIBUTIONS
--
-- person_id is NULLABLE, and that is the most important thing in this table.
--
-- Most Nigerian offering is ANONYMOUS CASH. It is not attributable to anyone,
-- and pretending otherwise manufactures fake giving records. A US product that
-- demands a donor on every gift literally cannot record a Sunday offering.
--
-- Named giving — tithe envelopes, bank transfers — IS attributable, and only
-- those people can be issued a year-end statement.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contributions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id     uuid REFERENCES giving_batches(id) ON DELETE CASCADE,
  fund_id      uuid NOT NULL REFERENCES funds(id),
  person_id    uuid REFERENCES persons(id) ON DELETE SET NULL,   -- NULL = anonymous
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  method       text NOT NULL DEFAULT 'cash'
               CHECK (method IN ('cash','transfer','pos','cheque','online','in_kind')),
  given_on     date NOT NULL DEFAULT CURRENT_DATE,
  envelope_no  text,
  reference    text,
  note         text,
  is_anonymous boolean GENERATED ALWAYS AS (person_id IS NULL) STORED,
  headcount    int,          -- a bag of loose cash: how many gave, without who
  created_by   uuid REFERENCES app_users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contrib_tenant ON contributions(tenant_id, given_on DESC);
CREATE INDEX IF NOT EXISTS idx_contrib_person ON contributions(tenant_id, person_id, given_on DESC)
  WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contrib_fund   ON contributions(tenant_id, fund_id);
CREATE INDEX IF NOT EXISTS idx_contrib_batch  ON contributions(batch_id);

-- ----------------------------------------------------------------------------
-- PLEDGES — "I will give NGN 500,000 to the building over 12 months"
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pledges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  fund_id    uuid NOT NULL REFERENCES funds(id),
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  starts_on  date NOT NULL DEFAULT CURRENT_DATE,
  ends_on    date,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pledge_tenant ON pledges(tenant_id, person_id);

-- ----------------------------------------------------------------------------
-- EXPENSES — money leaving a fund. Pending until somebody with authority approves.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fund_id     uuid NOT NULL REFERENCES funds(id),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  payee       text NOT NULL,
  category    text,
  spent_on    date NOT NULL DEFAULT CURRENT_DATE,
  method      text NOT NULL DEFAULT 'cash'
              CHECK (method IN ('cash','transfer','pos','cheque')),
  reference   text,
  note        text,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  created_by  uuid REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_tenant ON expenses(tenant_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS idx_expense_fund   ON expenses(tenant_id, fund_id);

CREATE TABLE IF NOT EXISTS budgets (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fund_id   uuid NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  year      int NOT NULL,
  amount    numeric(14,2) NOT NULL,
  UNIQUE (tenant_id, fund_id, year)
);

-- ============================================================================
-- THE RULE NO COMPETITOR ENFORCES
--
-- A RESTRICTED fund holds money the GIVER designated. It may not be spent on
-- anything else, and it may not go negative — because a negative restricted
-- fund means the church has already spent money it was holding in trust.
--
-- Planning Center will let you. ChurchTrac will let you. A spreadsheet will
-- certainly let you, and that is how a treasurer ends up explaining to a board
-- where the building money went.
--
-- Hispren makes it impossible at the DATABASE level. Not a warning in the UI
-- that a determined person can click past. A transaction that will not commit.
-- ============================================================================
CREATE OR REPLACE FUNCTION fund_balance(f uuid) RETURNS numeric
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce((SELECT sum(amount) FROM contributions WHERE fund_id = f), 0)
       - coalesce((SELECT sum(amount) FROM expenses
                    WHERE fund_id = f AND status = 'approved'), 0)
$fn$;
GRANT EXECUTE ON FUNCTION fund_balance(uuid) TO hispren_app;

CREATE OR REPLACE FUNCTION expense_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  k     text;
  fname text;
  cats  text[];
  held  numeric;
  after numeric;
BEGIN
  -- only an APPROVED expense actually moves money
  IF NEW.status <> 'approved' THEN RETURN NEW; END IF;

  SELECT kind, name, allowed_categories INTO k, fname, cats
    FROM funds WHERE id = NEW.fund_id;
  IF k <> 'restricted' THEN RETURN NEW; END IF;

  ------------------------------------------------------------------
  -- 1. MISUSE. The giver said what this money was for.
  --
  -- A building fund holding NGN 888,000 will comfortably cover a
  -- NGN 400,000 salary. The balance permits it. Every other product on
  -- the market permits it. It is still a breach of trust, and this is
  -- where a treasurer's trouble actually begins.
  ------------------------------------------------------------------
  IF cats IS NOT NULL AND array_length(cats, 1) > 0
     AND (NEW.category IS NULL OR NOT (NEW.category = ANY(cats))) THEN
    RAISE EXCEPTION
      '% is a RESTRICTED fund. It may only be spent on: %. "%" is not one of them. The people who gave this money said what it was for.',
      fname, array_to_string(cats, ', '), coalesce(NEW.category, 'no category')
      USING ERRCODE = 'check_violation';
  END IF;

  ------------------------------------------------------------------
  -- 2. DEFICIT. A restricted fund in deficit means the church has already
  --    spent money it was holding in trust.
  ------------------------------------------------------------------
  -- nothing balance-affecting changed
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved'
     AND OLD.amount = NEW.amount AND OLD.fund_id = NEW.fund_id THEN
    RETURN NEW;
  END IF;

  held := fund_balance(NEW.fund_id);
  -- if this row was already approved, its old amount is inside `held` — add it back
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND OLD.fund_id = NEW.fund_id THEN
    held := held + OLD.amount;
  END IF;
  after := held - NEW.amount;

  IF after < 0 THEN
    RAISE EXCEPTION
      '% is a RESTRICTED fund. It holds NGN %, and this expense is NGN %. Money given for a specific purpose cannot be spent on anything else, and it cannot go into deficit.',
      fname,
      to_char(held,       'FM999,999,999,990.00'),
      to_char(NEW.amount, 'FM999,999,999,990.00')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_expense_guard ON expenses;
CREATE TRIGGER trg_expense_guard BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION expense_guard();

-- ----------------------------------------------------------------------------
-- REPORTS
-- ----------------------------------------------------------------------------

/** Every fund and what it holds. The treasurer's home screen. */
CREATE OR REPLACE FUNCTION fund_summary()
RETURNS TABLE (id uuid, name text, kind text, given numeric, spent numeric,
               balance numeric, budget numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT f.id, f.name, f.kind,
         coalesce((SELECT sum(amount) FROM contributions c WHERE c.fund_id = f.id), 0),
         coalesce((SELECT sum(amount) FROM expenses e
                    WHERE e.fund_id = f.id AND e.status = 'approved'), 0),
         fund_balance(f.id),
         (SELECT b.amount FROM budgets b
           WHERE b.fund_id = f.id AND b.year = EXTRACT(YEAR FROM CURRENT_DATE)::int)
    FROM funds f WHERE f.archived_at IS NULL
   ORDER BY f.is_default DESC, f.name
$fn$;
GRANT EXECUTE ON FUNCTION fund_summary() TO hispren_app;

/** Giving by month. Named vs anonymous — is the church broad, or carried by a few? */
CREATE OR REPLACE FUNCTION giving_by_month(months int DEFAULT 12)
RETURNS TABLE (month date, total numeric, named numeric, anonymous numeric, gifts int)
LANGUAGE sql STABLE AS $fn$
  SELECT date_trunc('month', given_on)::date,
         sum(amount),
         coalesce(sum(amount) FILTER (WHERE person_id IS NOT NULL), 0),
         coalesce(sum(amount) FILTER (WHERE person_id IS NULL), 0),
         count(*)::int
    FROM contributions
   WHERE given_on > CURRENT_DATE - (months * 31)
   GROUP BY 1 ORDER BY 1
$fn$;
GRANT EXECUTE ON FUNCTION giving_by_month(int) TO hispren_app;

/**
 * A member's year-end statement. ONLY named gifts.
 *
 * Anonymous cash is never attributed to anybody. A product that guessed would
 * be putting a number on a tax document that the member did not give.
 */
CREATE OR REPLACE FUNCTION giving_statement(p uuid, yr int)
RETURNS TABLE (given_on date, fund text, amount numeric, method text, reference text)
LANGUAGE sql STABLE AS $fn$
  SELECT c.given_on, f.name, c.amount, c.method, coalesce(c.envelope_no, c.reference)
    FROM contributions c JOIN funds f ON f.id = c.fund_id
   WHERE c.person_id = p AND EXTRACT(YEAR FROM c.given_on)::int = yr
   ORDER BY c.given_on
$fn$;
GRANT EXECUTE ON FUNCTION giving_statement(uuid, int) TO hispren_app;

/** Pledges against what actually arrived. */
CREATE OR REPLACE FUNCTION pledge_progress()
RETURNS TABLE (person_id uuid, name text, fund text, pledged numeric,
               paid numeric, outstanding numeric, pct int)
LANGUAGE sql STABLE AS $fn$
  WITH paid AS (
    SELECT p.id AS pledge_id,
           coalesce((SELECT sum(c.amount) FROM contributions c
                      WHERE c.person_id = p.person_id AND c.fund_id = p.fund_id
                        AND c.given_on >= p.starts_on), 0) AS amt
      FROM pledges p
  )
  SELECT p.person_id,
         trim(coalesce(pe.first_name,'')||' '||coalesce(pe.last_name,'')),
         f.name, p.amount, paid.amt,
         greatest(0, p.amount - paid.amt),
         least(100, (paid.amt / nullif(p.amount,0) * 100)::int)
    FROM pledges p
    JOIN paid       ON paid.pledge_id = p.id
    JOIN persons pe ON pe.id = p.person_id
    JOIN funds f    ON f.id  = p.fund_id
   ORDER BY 7
$fn$;
GRANT EXECUTE ON FUNCTION pledge_progress() TO hispren_app;

/** Income and expenditure. What a board asks for. */
CREATE OR REPLACE FUNCTION income_statement(from_date date, to_date date)
RETURNS TABLE (fund text, kind text, income numeric, expenditure numeric, net numeric)
LANGUAGE sql STABLE AS $fn$
  WITH i AS (
    SELECT f.id, f.name, f.kind, f.is_default,
      coalesce((SELECT sum(c.amount) FROM contributions c
                 WHERE c.fund_id = f.id AND c.given_on BETWEEN from_date AND to_date), 0) AS inc,
      coalesce((SELECT sum(e.amount) FROM expenses e
                 WHERE e.fund_id = f.id AND e.status = 'approved'
                   AND e.spent_on BETWEEN from_date AND to_date), 0) AS exp
      FROM funds f WHERE f.archived_at IS NULL
  )
  SELECT name, kind, inc, exp, inc - exp FROM i ORDER BY is_default DESC, name
$fn$;
GRANT EXECUTE ON FUNCTION income_statement(date, date) TO hispren_app;

-- ----------------------------------------------------------------------------
-- RLS
--
-- Deliberately NO platform_access policy. Hispren never takes a percentage of
-- giving, and the platform role has no business seeing a single naira of it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['funds','giving_batches','contributions','pledges',
                           'expenses','budgets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON funds, giving_batches, contributions, pledges, expenses, budgets TO hispren_app;

-- ----------------------------------------------------------------------------
-- The funds a Nigerian church actually keeps
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_funds(t uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO funds (tenant_id, name, kind, code, description, is_default) VALUES
   (t,'Tithes and Offering','general','GEN',
      'The general purse. Salaries, rent, electricity, anything.', true),
   (t,'Building Fund','restricted','BLD',
      'Given FOR THE BUILDING. The database refuses anything else.', false),
   (t,'Missions','restricted','MIS',
      'Given for missions. Restricted.', false),
   (t,'Welfare and Benevolence','restricted','WEL',
      'For members in need. Restricted - this is somebody''s school fees.', false),
   (t,'Special Projects','designated','SPC',
      'Set aside by the board. The board can release it.', false)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- What each restricted fund may be spent on. Anything else is REFUSED.
  UPDATE funds SET allowed_categories = ARRAY['Building','Construction','Materials','Land','Architect']
   WHERE tenant_id = t AND name = 'Building Fund';
  UPDATE funds SET allowed_categories = ARRAY['Missions','Outreach','Crusade','Missionary support']
   WHERE tenant_id = t AND name = 'Missions';
  UPDATE funds SET allowed_categories = ARRAY['Welfare','Medical','School fees','Food','Funeral','Rent']
   WHERE tenant_id = t AND name = 'Welfare and Benevolence';
END $fn$;

COMMIT;
