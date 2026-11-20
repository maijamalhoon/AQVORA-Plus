-- AQVORA Plus independent, multi-company DMS accounting schema.
-- Run only against a dedicated AQVORA Plus PostgreSQL database (PostgreSQL 15+).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 30),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL CHECK (code IN ('SALES','SERVICE','PARTS','FINANCE')),
  name text NOT NULL,
  UNIQUE(company_id, id), UNIQUE(company_id, code)
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (position('@' IN email) > 1),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('ADMIN','FINANCE','SALES','SERVICE','PARTS','VIEWER')),
  department_id uuid,
  PRIMARY KEY(company_id, user_id),
  FOREIGN KEY(company_id, department_id) REFERENCES departments(company_id, id)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK(length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  active boolean NOT NULL DEFAULT true,
  UNIQUE(company_id, code), UNIQUE(company_id, id)
);

CREATE TABLE fiscal_periods (
  company_id uuid NOT NULL REFERENCES companies(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED')),
  PRIMARY KEY(company_id, period)
);

CREATE TABLE voucher_sequences (
  company_id uuid NOT NULL REFERENCES companies(id),
  voucher_type text NOT NULL CHECK (voucher_type IN ('JV','CB/R','CB/P','BB/R','BB/P','REV')),
  period text NOT NULL,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY(company_id, voucher_type, period)
);

CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  department_id uuid NOT NULL,
  voucher_type text NOT NULL CHECK (voucher_type IN ('JV','CB/R','CB/P','BB/R','BB/P','REV')),
  voucher_date date NOT NULL,
  voucher_number text,
  narrative text NOT NULL CHECK(length(trim(narrative)) > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','POSTED')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES app_users(id),
  posted_at timestamptz,
  reverses_id uuid,
  UNIQUE(company_id, id),
  UNIQUE(company_id, voucher_number),
  FOREIGN KEY(company_id, department_id) REFERENCES departments(company_id,id),
  FOREIGN KEY(company_id, reverses_id) REFERENCES vouchers(company_id,id)
);
CREATE UNIQUE INDEX vouchers_unique_reversal ON vouchers(company_id,reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX vouchers_company_date ON vouchers(company_id,voucher_date DESC);

CREATE TABLE voucher_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  account_id uuid NOT NULL,
  line_number integer NOT NULL CHECK(line_number > 0),
  debit_paisa bigint NOT NULL DEFAULT 0 CHECK (debit_paisa >= 0),
  credit_paisa bigint NOT NULL DEFAULT 0 CHECK (credit_paisa >= 0),
  CHECK ((debit_paisa > 0 AND credit_paisa = 0) OR (credit_paisa > 0 AND debit_paisa = 0)),
  UNIQUE(voucher_id,line_number),
  FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
  FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id)
);
CREATE INDEX voucher_lines_account_idx ON voucher_lines(company_id,account_id);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  action text NOT NULL,
  entity_id uuid NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_company_time ON audit_events(company_id,occurred_at DESC);

-- Defence in depth: posted vouchers and their lines are immutable.
CREATE FUNCTION protect_voucher_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_count int; dr numeric; cr numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN RAISE EXCEPTION 'Posted vouchers cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'Posted vouchers cannot be changed; create a reversal';
  END IF;
  IF NEW.status = 'POSTED' THEN
    SELECT count(*), coalesce(sum(debit_paisa),0), coalesce(sum(credit_paisa),0)
    INTO row_count,dr,cr FROM voucher_lines WHERE voucher_id = NEW.id AND company_id = NEW.company_id;
    IF row_count < 2 OR dr = 0 OR dr <> cr THEN
      RAISE EXCEPTION 'Unbalanced journal posting';
    END IF;
    IF NEW.voucher_number IS NULL OR NEW.posted_by IS NULL OR NEW.posted_at IS NULL THEN
      RAISE EXCEPTION 'Incomplete journal posting metadata';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_guard BEFORE UPDATE OR DELETE ON vouchers
FOR EACH ROW EXECUTE FUNCTION protect_voucher_row();

CREATE FUNCTION protect_voucher_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text; key_id uuid; tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    key_id := OLD.voucher_id; tenant := OLD.company_id;
  ELSE
    key_id := NEW.voucher_id; tenant := NEW.company_id;
  END IF;
  SELECT status INTO state FROM vouchers WHERE id=key_id AND company_id=tenant;
  IF state = 'POSTED' THEN
    RAISE EXCEPTION 'Posted journal lines cannot be modified';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voucher_id <> NEW.voucher_id OR OLD.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'Journal lines cannot be moved between vouchers';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_line_guard BEFORE INSERT OR UPDATE OR DELETE ON voucher_lines
FOR EACH ROW EXECUTE FUNCTION protect_voucher_line();

COMMIT;
