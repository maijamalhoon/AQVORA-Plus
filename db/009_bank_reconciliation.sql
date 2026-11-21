-- Phase 11: company-scoped bank statement matching, financial read-only BRS.
-- Bank statement amounts: positive means cash IN, negative means cash OUT.
BEGIN;

ALTER TABLE voucher_lines ADD CONSTRAINT voucher_lines_tenant_id_unique UNIQUE(company_id,id);

CREATE TABLE brs_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 account_id uuid NOT NULL,
 statement_reference text NOT NULL CHECK(length(trim(statement_reference)) BETWEEN 4 AND 120),
 starts_on date NOT NULL,
 ends_on date NOT NULL,
 opening_paisa bigint NOT NULL,
 closing_paisa bigint NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','FINALIZED')),
 imported_by uuid NOT NULL REFERENCES app_users(id),
 reviewed_by uuid REFERENCES app_users(id),
 reviewed_at timestamptz,
 imported_at timestamptz NOT NULL DEFAULT now(),
 CHECK(starts_on<=ends_on),
 CHECK(opening_paisa BETWEEN -9007199254740991 AND 9007199254740991),
 CHECK(closing_paisa BETWEEN -9007199254740991 AND 9007199254740991),
 CHECK((status='DRAFT' AND reviewed_by IS NULL AND reviewed_at IS NULL)
       OR (status='FINALIZED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND imported_by<>reviewed_by)),
 FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),
 UNIQUE(company_id,id),
 UNIQUE(company_id,account_id,statement_reference)
);
CREATE INDEX brs_batch_tenant_dates ON brs_batches(company_id,account_id,ends_on DESC);

CREATE TABLE brs_statement_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 batch_id uuid NOT NULL,
 account_id uuid NOT NULL,
 line_number integer NOT NULL CHECK(line_number BETWEEN 1 AND 100),
 bank_transaction_id text NOT NULL CHECK(length(trim(bank_transaction_id)) BETWEEN 3 AND 120),
 value_date date NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa<>0 AND amount_paisa BETWEEN -9007199254740991 AND 9007199254740991),
 description text NOT NULL CHECK(length(trim(description)) BETWEEN 3 AND 500),
 FOREIGN KEY(company_id,batch_id) REFERENCES brs_batches(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),
 UNIQUE(company_id,id),
 UNIQUE(company_id,batch_id,line_number),
 UNIQUE(company_id,account_id,bank_transaction_id)
);
CREATE INDEX brs_statement_batch_date ON brs_statement_lines(company_id,batch_id,value_date);

CREATE TABLE brs_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 batch_id uuid NOT NULL,
 statement_line_id uuid NOT NULL,
 voucher_line_id uuid NOT NULL,
 matched_by uuid NOT NULL REFERENCES app_users(id),
 matched_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,batch_id) REFERENCES brs_batches(company_id,id),
 FOREIGN KEY(company_id,statement_line_id) REFERENCES brs_statement_lines(company_id,id),
 FOREIGN KEY(company_id,voucher_line_id) REFERENCES voucher_lines(company_id,id),
 UNIQUE(company_id,id),
 UNIQUE(company_id,statement_line_id),
 UNIQUE(company_id,voucher_line_id)
);
CREATE INDEX brs_matches_batch ON brs_matches(company_id,batch_id);

CREATE FUNCTION brs_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bank statement batches cannot be deleted'; END IF;
 IF OLD.status<>'DRAFT' OR NEW.status<>'FINALIZED' OR
   (to_jsonb(NEW)-'status'-'reviewed_by'-'reviewed_at')
      IS DISTINCT FROM (to_jsonb(OLD)-'status'-'reviewed_by'-'reviewed_at')
   OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR
   NEW.reviewed_by=OLD.imported_by THEN
     RAISE EXCEPTION 'Invalid or unauthorized BRS finalization state transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brs_batches_guard BEFORE UPDATE OR DELETE ON brs_batches
 FOR EACH ROW EXECUTE FUNCTION brs_batch_guard();

CREATE FUNCTION brs_statement_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b brs_batches%ROWTYPE;
BEGIN
 SELECT * INTO b FROM brs_batches WHERE company_id=NEW.company_id AND id=NEW.batch_id FOR UPDATE;
 IF NOT FOUND OR b.status<>'DRAFT' THEN
   RAISE EXCEPTION 'Cannot insert bank lines into a missing or finalized BRS batch';
 END IF;
 IF NEW.account_id<>b.account_id OR NEW.value_date<b.starts_on OR NEW.value_date>b.ends_on THEN
   RAISE EXCEPTION 'Bank statement movement must use its own account and statement period';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brs_statement_insert_guard BEFORE INSERT ON brs_statement_lines
 FOR EACH ROW EXECUTE FUNCTION brs_statement_insert_guard();

CREATE FUNCTION brs_statement_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Imported bank statement lines are immutable'; END $$;
CREATE TRIGGER brs_statement_lines_append_only BEFORE UPDATE OR DELETE ON brs_statement_lines
 FOR EACH ROW EXECUTE FUNCTION brs_statement_line_guard();

CREATE FUNCTION brs_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b brs_batches%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Bank match entries cannot be edited'; END IF;
 SELECT * INTO b FROM brs_batches WHERE company_id=OLD.company_id AND id=OLD.batch_id FOR UPDATE;
 IF b.status<>'DRAFT' THEN RAISE EXCEPTION 'Finalized BRS matches cannot be deleted'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER brs_matches_guard BEFORE UPDATE OR DELETE ON brs_matches
 FOR EACH ROW EXECUTE FUNCTION brs_match_guard();

-- Prevent accidental database-level wrong-amount or cross-account matching even
-- when an application/ORM bypasses the standard API.
CREATE FUNCTION brs_validate_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b brs_batches%ROWTYPE; sl brs_statement_lines%ROWTYPE;
        gl record;
BEGIN
 SELECT * INTO b FROM brs_batches WHERE company_id=NEW.company_id AND id=NEW.batch_id FOR UPDATE;
 IF NOT FOUND OR b.status<>'DRAFT' THEN RAISE EXCEPTION 'Bank reconciliation batch is not open'; END IF;
 SELECT * INTO sl FROM brs_statement_lines WHERE company_id=NEW.company_id AND id=NEW.statement_line_id;
 IF NOT FOUND OR sl.batch_id<>NEW.batch_id OR sl.account_id<>b.account_id
   THEN RAISE EXCEPTION 'Bank statement row does not belong to this batch'; END IF;
 SELECT l.account_id,l.debit_paisa-l.credit_paisa AS signed_amount,v.status,v.voucher_date
 INTO gl FROM voucher_lines l JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
 WHERE l.company_id=NEW.company_id AND l.id=NEW.voucher_line_id;
 IF NOT FOUND OR gl.account_id<>b.account_id OR gl.status<>'POSTED'
   OR gl.signed_amount<>sl.amount_paisa OR gl.voucher_date>b.ends_on THEN
   RAISE EXCEPTION 'Bank match requires same-account posted GL entry, signed amount and cutoff'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brs_match_validate BEFORE INSERT ON brs_matches
 FOR EACH ROW EXECUTE FUNCTION brs_validate_match();

COMMIT;
