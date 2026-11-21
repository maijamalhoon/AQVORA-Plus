-- AQVORA Plus — Phase 4: accounted procurement, vehicle sales and stock valuation.
-- Requires 001_initial.sql and 002_automotive.sql. Independent from AQVORA ERP.
BEGIN;
ALTER TABLE document_sequences DROP CONSTRAINT document_sequences_code_check;
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_code_check
  CHECK(code IN ('SO','JC','SI','PI','VI'));

CREATE TABLE suppliers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 140),
 phone text,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id)
);

ALTER TABLE vehicle_stock ADD COLUMN purchase_cost_paisa bigint
  CHECK(purchase_cost_paisa>0);
ALTER TABLE vehicle_stock ADD COLUMN acquisition_voucher_id uuid;
ALTER TABLE vehicle_stock ADD CONSTRAINT vehicle_acquisition_company_fk
  FOREIGN KEY(company_id,acquisition_voucher_id) REFERENCES vouchers(company_id,id);
ALTER TABLE vehicle_stock ADD CONSTRAINT accounted_vehicle_must_have_cost
 CHECK((acquisition_voucher_id IS NULL AND purchase_cost_paisa IS NULL)
    OR(acquisition_voucher_id IS NOT NULL AND purchase_cost_paisa>0));
ALTER TABLE vehicle_stock DROP CONSTRAINT vehicle_stock_status_check;
ALTER TABLE vehicle_stock ADD CONSTRAINT vehicle_stock_status_check
 CHECK(status IN ('IN_STOCK','RESERVED','SOLD'));
CREATE UNIQUE INDEX vehicle_acquisition_unique
 ON vehicle_stock(company_id,acquisition_voucher_id) WHERE acquisition_voucher_id IS NOT NULL;

ALTER TABLE parts ADD COLUMN inventory_value_paisa bigint NOT NULL DEFAULT 0
 CHECK(inventory_value_paisa>=0);
ALTER TABLE parts ADD COLUMN valuation_mode text NOT NULL DEFAULT 'LEGACY'
 CHECK(valuation_mode IN ('LEGACY','POSTED'));
ALTER TABLE parts ADD CONSTRAINT parts_valuation_consistency CHECK(
  (valuation_mode='LEGACY' AND inventory_value_paisa=0)
  OR (valuation_mode='POSTED' AND
     ((stock_qty=0 AND inventory_value_paisa=0) OR
      (stock_qty>0 AND inventory_value_paisa>0)))
);

ALTER TABLE stock_movements ADD COLUMN accounting_voucher_id uuid;
ALTER TABLE stock_movements ADD COLUMN cost_total_paisa bigint
  CHECK(cost_total_paisa IS NULL OR cost_total_paisa>=0);
ALTER TABLE stock_movements ADD CONSTRAINT movement_accounting_company_fk
 FOREIGN KEY(company_id,accounting_voucher_id) REFERENCES vouchers(company_id,id);
CREATE UNIQUE INDEX movement_accounting_one_voucher
 ON stock_movements(company_id,accounting_voucher_id) WHERE accounting_voucher_id IS NOT NULL;
ALTER TABLE stock_movements ADD CONSTRAINT movement_cost_link_consistency
 CHECK((accounting_voucher_id IS NULL AND cost_total_paisa IS NULL)
    OR (accounting_voucher_id IS NOT NULL AND cost_total_paisa>0));

CREATE TABLE purchase_bills(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 supplier_id uuid NOT NULL,
 supplier_invoice_no text NOT NULL CHECK(length(trim(supplier_invoice_no)) BETWEEN 2 AND 80),
 reference text NOT NULL,
 bill_type text NOT NULL CHECK(bill_type IN ('VEHICLE','PARTS')),
 invoice_date date NOT NULL,
 due_date date NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa>0),
 paid_paisa bigint NOT NULL DEFAULT 0 CHECK(paid_paisa>=0 AND paid_paisa<=amount_paisa),
 voucher_id uuid NOT NULL,
 vehicle_id uuid,
 part_id uuid,
 quantity integer,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(due_date>=invoice_date),
 CHECK((bill_type='VEHICLE' AND vehicle_id IS NOT NULL AND part_id IS NULL AND quantity IS NULL)
    OR (bill_type='PARTS' AND vehicle_id IS NULL AND part_id IS NOT NULL AND quantity>0)),
 FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 FOREIGN KEY(company_id,vehicle_id) REFERENCES vehicle_stock(company_id,id),
 FOREIGN KEY(company_id,part_id) REFERENCES parts(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,reference),
 UNIQUE(company_id,supplier_id,supplier_invoice_no),
 UNIQUE(company_id,voucher_id)
);
CREATE UNIQUE INDEX one_purchase_per_vehicle
 ON purchase_bills(company_id,vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX purchase_bills_company_due ON purchase_bills(company_id,due_date);

CREATE TABLE supplier_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 bill_id uuid NOT NULL,
 payment_date date NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa>0),
 client_key uuid NOT NULL,
 voucher_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,bill_id) REFERENCES purchase_bills(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,client_key),UNIQUE(company_id,voucher_id)
);

CREATE TABLE vehicle_sales_invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 booking_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 vehicle_id uuid NOT NULL,
 invoice_date date NOT NULL,
 due_date date NOT NULL,
 sales_amount_paisa bigint NOT NULL CHECK(sales_amount_paisa>0),
 cogs_paisa bigint NOT NULL CHECK(cogs_paisa>0),
 paid_paisa bigint NOT NULL DEFAULT 0 CHECK(paid_paisa>=0 AND paid_paisa<=sales_amount_paisa),
 revenue_voucher_id uuid NOT NULL,
 cogs_voucher_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(due_date>=invoice_date),
 FOREIGN KEY(company_id,booking_id) REFERENCES sales_bookings(company_id,id),
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
 FOREIGN KEY(company_id,vehicle_id) REFERENCES vehicle_stock(company_id,id),
 FOREIGN KEY(company_id,revenue_voucher_id) REFERENCES vouchers(company_id,id),
 FOREIGN KEY(company_id,cogs_voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,reference),UNIQUE(company_id,booking_id),
 UNIQUE(company_id,vehicle_id),UNIQUE(company_id,revenue_voucher_id),UNIQUE(company_id,cogs_voucher_id)
);
CREATE INDEX vehicle_sales_invoice_company_due ON vehicle_sales_invoices(company_id,due_date);

CREATE TABLE vehicle_sales_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 invoice_id uuid NOT NULL,
 payment_date date NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa>0),
 client_key uuid NOT NULL,
 voucher_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,invoice_id) REFERENCES vehicle_sales_invoices(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,client_key),UNIQUE(company_id,voucher_id)
);

-- Once issued, document source fields and posted accounting identities are immutable.
CREATE FUNCTION guard_phase4_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE amount_due bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted financial documents are immutable'; END IF;
 IF (to_jsonb(NEW) - 'paid_paisa') IS DISTINCT FROM (to_jsonb(OLD) - 'paid_paisa') THEN
   RAISE EXCEPTION 'Posted financial document fields cannot be changed';
 END IF;
 IF NEW.paid_paisa < OLD.paid_paisa THEN
   RAISE EXCEPTION 'Paid amount cannot decrease; issue a traceable correction instead';
 END IF;
 IF TG_TABLE_NAME='purchase_bills' THEN
   SELECT coalesce(sum(amount_paisa),0) INTO amount_due FROM supplier_payments
    WHERE company_id=NEW.company_id AND bill_id=NEW.id;
 ELSE
   SELECT coalesce(sum(amount_paisa),0) INTO amount_due FROM vehicle_sales_payments
    WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
 END IF;
 IF NEW.paid_paisa<>amount_due THEN RAISE EXCEPTION 'Payment subledger does not reconcile'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_bills_protect BEFORE UPDATE OR DELETE ON purchase_bills
 FOR EACH ROW EXECUTE FUNCTION guard_phase4_document();
CREATE TRIGGER vehicle_sales_invoices_protect BEFORE UPDATE OR DELETE ON vehicle_sales_invoices
 FOR EACH ROW EXECUTE FUNCTION guard_phase4_document();

CREATE FUNCTION reject_phase4_history_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Posted payment history is immutable';
END $$;
CREATE TRIGGER supplier_payments_guard BEFORE UPDATE OR DELETE ON supplier_payments
 FOR EACH ROW EXECUTE FUNCTION reject_phase4_history_changes();
CREATE TRIGGER vehicle_sales_payments_guard BEFORE UPDATE OR DELETE ON vehicle_sales_payments
 FOR EACH ROW EXECUTE FUNCTION reject_phase4_history_changes();

-- Booked vehicle cannot be released after its accounted sale.
CREATE FUNCTION guard_sold_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='BOOKED' AND NEW.status='CANCELLED' AND EXISTS(
   SELECT 1 FROM vehicle_sales_invoices
   WHERE company_id=OLD.company_id AND booking_id=OLD.id
 ) THEN
   RAISE EXCEPTION 'Cannot cancel invoiced vehicle booking';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sold_booking_guard BEFORE UPDATE ON sales_bookings
 FOR EACH ROW EXECUTE FUNCTION guard_sold_booking();
COMMIT;
