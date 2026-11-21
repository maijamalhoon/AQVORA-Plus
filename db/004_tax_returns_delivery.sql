-- AQVORA Plus Phase 5: audited tax snapshots, vendor returns, credit notes and delivery.
-- Requires migrations 001 through 003. No statutory tax rate is assumed.
BEGIN;
ALTER TABLE document_sequences DROP CONSTRAINT document_sequences_code_check;
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_code_check
 CHECK(code IN ('SO','JC','SI','PI','VI','PR','CN','DL'));

CREATE TABLE tax_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 code text NOT NULL CHECK(length(trim(code)) BETWEEN 2 AND 40),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 140),
 rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,code)
);
-- Codes/rates remain permanent; create a new code for a future rate change.
CREATE FUNCTION deny_tax_code_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Tax codes are immutable; create a new code'; END $$;
CREATE TRIGGER tax_code_immutable BEFORE UPDATE OR DELETE ON tax_codes
 FOR EACH ROW EXECUTE FUNCTION deny_tax_code_mutation();

ALTER TABLE vehicle_sales_invoices ADD COLUMN tax_code_id uuid;
ALTER TABLE vehicle_sales_invoices ADD COLUMN tax_rate_bps integer NOT NULL DEFAULT 0
 CHECK(tax_rate_bps BETWEEN 0 AND 10000);
ALTER TABLE vehicle_sales_invoices ADD COLUMN sales_tax_paisa bigint NOT NULL DEFAULT 0
 CHECK(sales_tax_paisa>=0);
ALTER TABLE vehicle_sales_invoices ADD COLUMN tax_voucher_id uuid;
ALTER TABLE vehicle_sales_invoices ADD COLUMN credited_net_paisa bigint NOT NULL DEFAULT 0
 CHECK(credited_net_paisa>=0);
ALTER TABLE vehicle_sales_invoices ADD COLUMN credited_tax_paisa bigint NOT NULL DEFAULT 0
 CHECK(credited_tax_paisa>=0);
ALTER TABLE vehicle_sales_invoices ADD COLUMN gross_amount_paisa bigint GENERATED ALWAYS AS
 (sales_amount_paisa + sales_tax_paisa) STORED;
DO $$
DECLARE existing_check text;
BEGIN
 SELECT c.conname INTO existing_check FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 WHERE t.relname='vehicle_sales_invoices' AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%paid_paisa%'
   AND pg_get_constraintdef(c.oid) LIKE '%sales_amount_paisa%'
 ORDER BY c.oid LIMIT 1;
 IF existing_check IS NULL THEN
   RAISE EXCEPTION 'Original vehicle sales paid amount constraint not found';
 END IF;
 EXECUTE format('ALTER TABLE vehicle_sales_invoices DROP CONSTRAINT %I',existing_check);
END $$;
ALTER TABLE vehicle_sales_invoices ADD CONSTRAINT vehicle_sale_net_tax_credits
 CHECK(credited_net_paisa<=sales_amount_paisa
   AND credited_tax_paisa<=sales_tax_paisa
   AND paid_paisa>=0
   AND paid_paisa+credited_net_paisa+credited_tax_paisa<=gross_amount_paisa);
ALTER TABLE vehicle_sales_invoices ADD CONSTRAINT vehicle_sale_tax_snapshot_link
 CHECK((tax_code_id IS NULL AND tax_rate_bps=0 AND sales_tax_paisa=0 AND tax_voucher_id IS NULL)
 OR (tax_code_id IS NOT NULL AND
     ((sales_tax_paisa=0 AND tax_voucher_id IS NULL)
      OR (sales_tax_paisa>0 AND tax_voucher_id IS NOT NULL))));
ALTER TABLE vehicle_sales_invoices ADD FOREIGN KEY(company_id,tax_code_id) REFERENCES tax_codes(company_id,id);
ALTER TABLE vehicle_sales_invoices ADD FOREIGN KEY(company_id,tax_voucher_id) REFERENCES vouchers(company_id,id);
CREATE UNIQUE INDEX vehicle_sales_tax_voucher_unique ON vehicle_sales_invoices(company_id,tax_voucher_id)
 WHERE tax_voucher_id IS NOT NULL;

ALTER TABLE purchase_bills ADD COLUMN returned_qty integer NOT NULL DEFAULT 0 CHECK(returned_qty>=0);
ALTER TABLE purchase_bills ADD COLUMN credited_paisa bigint NOT NULL DEFAULT 0 CHECK(credited_paisa>=0);
DO $$
DECLARE existing_check text;
BEGIN
 SELECT c.conname INTO existing_check FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 WHERE t.relname='purchase_bills' AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%paid_paisa%'
   AND pg_get_constraintdef(c.oid) LIKE '%amount_paisa%'
 ORDER BY c.oid LIMIT 1;
 IF existing_check IS NULL THEN
   RAISE EXCEPTION 'Original supplier bill paid amount constraint not found';
 END IF;
 EXECUTE format('ALTER TABLE purchase_bills DROP CONSTRAINT %I',existing_check);
END $$;
ALTER TABLE purchase_bills ADD CONSTRAINT purchase_credit_limits
 CHECK(credited_paisa<=amount_paisa AND paid_paisa>=0
 AND paid_paisa+credited_paisa<=amount_paisa
 AND (bill_type='VEHICLE' AND returned_qty=0 OR bill_type='PARTS' AND returned_qty<=quantity));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_direction_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction_check CHECK(direction IN ('RECEIPT','ISSUE','RETURN'));
DO $$
DECLARE existing_check text;
BEGIN
 SELECT c.conname INTO existing_check FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 WHERE t.relname='stock_movements' AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%direction%'
   AND pg_get_constraintdef(c.oid) LIKE '%job_id%'
 ORDER BY c.oid LIMIT 1;
 IF existing_check IS NULL THEN
   RAISE EXCEPTION 'Original stock movement/job linkage constraint not found';
 END IF;
 EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I',existing_check);
END $$;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_check
 CHECK((direction='ISSUE' AND job_id IS NOT NULL)
 OR (direction IN ('RECEIPT','RETURN') AND job_id IS NULL));

CREATE TABLE purchase_returns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 bill_id uuid NOT NULL,
 part_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),
 supplier_credit_paisa bigint NOT NULL CHECK(supplier_credit_paisa>0),
 inventory_cost_paisa bigint NOT NULL CHECK(inventory_cost_paisa>0),
 variance_paisa bigint NOT NULL,
 voucher_id uuid NOT NULL,
 client_key uuid NOT NULL,
 return_date date NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 2000),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,bill_id) REFERENCES purchase_bills(company_id,id),
 FOREIGN KEY(company_id,part_id) REFERENCES parts(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,reference),UNIQUE(company_id,client_key),UNIQUE(company_id,voucher_id)
);

CREATE TABLE vehicle_credit_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 invoice_id uuid NOT NULL,
 net_paisa bigint NOT NULL CHECK(net_paisa>0),
 tax_paisa bigint NOT NULL DEFAULT 0 CHECK(tax_paisa>=0),
 revenue_voucher_id uuid NOT NULL,
 tax_voucher_id uuid,
 client_key uuid NOT NULL,
 issued_on date NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 2000),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,invoice_id) REFERENCES vehicle_sales_invoices(company_id,id),
 FOREIGN KEY(company_id,revenue_voucher_id) REFERENCES vouchers(company_id,id),
 FOREIGN KEY(company_id,tax_voucher_id) REFERENCES vouchers(company_id,id),
 CHECK ((tax_paisa=0 AND tax_voucher_id IS NULL) OR (tax_paisa>0 AND tax_voucher_id IS NOT NULL)),
 UNIQUE(company_id,id),UNIQUE(company_id,reference),UNIQUE(company_id,client_key),
 UNIQUE(company_id,revenue_voucher_id)
);
CREATE UNIQUE INDEX vehicle_credit_tax_posting_unique
 ON vehicle_credit_notes(company_id,tax_voucher_id) WHERE tax_voucher_id IS NOT NULL;

CREATE TABLE vehicle_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 invoice_id uuid NOT NULL,
 delivered_on date NOT NULL,
 recipient text NOT NULL CHECK(length(trim(recipient)) BETWEEN 2 AND 140),
 odometer_km integer NOT NULL CHECK(odometer_km BETWEEN 0 AND 1000000),
 notes text CHECK(notes IS NULL OR length(notes)<=2000),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,invoice_id) REFERENCES vehicle_sales_invoices(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,reference),UNIQUE(company_id,invoice_id)
);
CREATE FUNCTION deny_phase5_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Issued source documents cannot be edited or deleted'; END $$;
CREATE TRIGGER purchase_return_history_guard BEFORE UPDATE OR DELETE ON purchase_returns
 FOR EACH ROW EXECUTE FUNCTION deny_phase5_history_change();
CREATE TRIGGER vehicle_credit_history_guard BEFORE UPDATE OR DELETE ON vehicle_credit_notes
 FOR EACH ROW EXECUTE FUNCTION deny_phase5_history_change();
CREATE TRIGGER vehicle_delivery_history_guard BEFORE UPDATE OR DELETE ON vehicle_deliveries
 FOR EACH ROW EXECUTE FUNCTION deny_phase5_history_change();

-- Allow only paid and credited aggregates to change; match to immutable source rows.
CREATE OR REPLACE FUNCTION guard_phase4_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_total bigint; credit_total bigint; qty_total bigint; tax_total bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted financial documents are immutable'; END IF;
 IF TG_TABLE_NAME='purchase_bills' THEN
   IF (to_jsonb(NEW) - 'paid_paisa' - 'credited_paisa' - 'returned_qty')
     IS DISTINCT FROM (to_jsonb(OLD) - 'paid_paisa' - 'credited_paisa' - 'returned_qty') THEN
     RAISE EXCEPTION 'Posted purchase bill fields cannot be changed';
   END IF;
   SELECT coalesce(sum(amount_paisa),0) INTO paid_total FROM supplier_payments
    WHERE company_id=NEW.company_id AND bill_id=NEW.id;
   SELECT coalesce(sum(supplier_credit_paisa),0),coalesce(sum(quantity),0)
     INTO credit_total,qty_total FROM purchase_returns
    WHERE company_id=NEW.company_id AND bill_id=NEW.id;
   IF NEW.paid_paisa<>paid_total OR NEW.credited_paisa<>credit_total OR NEW.returned_qty<>qty_total THEN
     RAISE EXCEPTION 'Purchase bill paid and credit amounts must match immutable history';
   END IF;
 ELSE
   IF (to_jsonb(NEW) - 'paid_paisa' - 'credited_net_paisa' - 'credited_tax_paisa')
     IS DISTINCT FROM (to_jsonb(OLD) - 'paid_paisa' - 'credited_net_paisa' - 'credited_tax_paisa') THEN
     RAISE EXCEPTION 'Posted vehicle invoice fields cannot be changed';
   END IF;
   SELECT coalesce(sum(amount_paisa),0) INTO paid_total FROM vehicle_sales_payments
    WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
   SELECT coalesce(sum(net_paisa),0),coalesce(sum(tax_paisa),0)
     INTO credit_total,tax_total FROM vehicle_credit_notes
    WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
   IF NEW.paid_paisa<>paid_total OR NEW.credited_net_paisa<>credit_total
     OR NEW.credited_tax_paisa<>tax_total THEN
     RAISE EXCEPTION 'Vehicle invoice paid and credit amounts must match immutable history';
   END IF;
 END IF;
 IF NEW.paid_paisa<OLD.paid_paisa THEN RAISE EXCEPTION 'Paid amount cannot decrease'; END IF;
 IF TG_TABLE_NAME='purchase_bills' THEN
   IF NEW.credited_paisa<OLD.credited_paisa OR NEW.returned_qty<OLD.returned_qty THEN
     RAISE EXCEPTION 'Supplier credit amount cannot decrease';
   END IF;
 ELSE
   IF NEW.credited_net_paisa<OLD.credited_net_paisa OR NEW.credited_tax_paisa<OLD.credited_tax_paisa THEN
     RAISE EXCEPTION 'Customer credit amount cannot decrease';
   END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
