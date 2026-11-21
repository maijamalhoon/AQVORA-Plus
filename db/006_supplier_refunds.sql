-- AQVORA Plus Phase 7: supplier parts return + verified bank refund receipt.
-- Requires prior migrations 001-005. All source changes and GL postings are atomic.
BEGIN;

ALTER TABLE purchase_bills ADD COLUMN refunded_paisa bigint NOT NULL DEFAULT 0 CHECK(refunded_paisa>=0);
ALTER TABLE purchase_bills DROP CONSTRAINT purchase_credit_limits;
ALTER TABLE purchase_bills ADD CONSTRAINT purchase_credit_limits
 CHECK(credited_paisa<=amount_paisa AND refunded_paisa<=credited_paisa
   AND refunded_paisa<=paid_paisa
   AND paid_paisa+credited_paisa<=amount_paisa+refunded_paisa
   AND ((bill_type='VEHICLE' AND returned_qty=0) OR
        (bill_type='PARTS' AND returned_qty<=quantity)));

CREATE TABLE supplier_refund_policies (
 company_id uuid PRIMARY KEY REFERENCES companies(id),
 max_single_refund_paisa bigint NOT NULL CHECK(max_single_refund_paisa>0),
 updated_by uuid NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_refund_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 bill_id uuid NOT NULL,
 part_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),
 supplier_credit_paisa bigint NOT NULL CHECK(supplier_credit_paisa>0),
 return_date date NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 8 AND 2000),
 client_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','EXECUTED')),
 requested_by uuid NOT NULL REFERENCES app_users(id),
 approved_by uuid REFERENCES app_users(id),
 reviewed_at timestamptz,
 executed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(requested_by IS DISTINCT FROM approved_by),
 CHECK(
  (status='PENDING' AND approved_by IS NULL AND reviewed_at IS NULL AND executed_at IS NULL)
  OR (status IN ('APPROVED','REJECTED') AND approved_by IS NOT NULL AND reviewed_at IS NOT NULL AND executed_at IS NULL)
  OR (status='EXECUTED' AND approved_by IS NOT NULL AND reviewed_at IS NOT NULL AND executed_at IS NOT NULL)
 ),
 FOREIGN KEY(company_id,bill_id) REFERENCES purchase_bills(company_id,id),
 FOREIGN KEY(company_id,part_id) REFERENCES parts(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,client_key)
);
CREATE INDEX supplier_refund_request_queue ON supplier_refund_requests(company_id,status,created_at DESC);

ALTER TABLE purchase_returns ADD COLUMN supplier_refund_request_id uuid;
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_return_refund_request_fk
 FOREIGN KEY(company_id,supplier_refund_request_id) REFERENCES supplier_refund_requests(company_id,id);
CREATE UNIQUE INDEX single_return_per_supplier_refund_request
 ON purchase_returns(company_id,supplier_refund_request_id)
 WHERE supplier_refund_request_id IS NOT NULL;

CREATE TABLE supplier_refund_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 request_id uuid NOT NULL,
 bill_id uuid NOT NULL,
 purchase_return_id uuid NOT NULL,
 refund_date date NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa>0),
 bank_reference text NOT NULL CHECK(length(trim(bank_reference)) BETWEEN 4 AND 120),
 voucher_id uuid NOT NULL,
 recorded_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,request_id) REFERENCES supplier_refund_requests(company_id,id),
 FOREIGN KEY(company_id,bill_id) REFERENCES purchase_bills(company_id,id),
 FOREIGN KEY(company_id,purchase_return_id) REFERENCES purchase_returns(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,request_id),UNIQUE(company_id,bank_reference),
 UNIQUE(company_id,purchase_return_id),UNIQUE(company_id,voucher_id)
);
CREATE INDEX supplier_refund_bill_history ON supplier_refund_receipts(company_id,bill_id);

CREATE FUNCTION prevent_supplier_refund_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recorded supplier refund receipts are immutable'; END $$;
CREATE TRIGGER supplier_refund_receipt_immutable BEFORE UPDATE OR DELETE ON supplier_refund_receipts
 FOR EACH ROW EXECUTE FUNCTION prevent_supplier_refund_mutation();

CREATE FUNCTION supplier_refund_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Supplier refund requests cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'status'-'approved_by'-'reviewed_at'-'executed_at')
   IS DISTINCT FROM (to_jsonb(OLD)-'status'-'approved_by'-'reviewed_at'-'executed_at') THEN
   RAISE EXCEPTION 'Supplier refund request details are immutable';
 END IF;
 IF OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED')
   AND NEW.approved_by IS NOT NULL AND NEW.approved_by<>OLD.requested_by
   AND NEW.reviewed_at IS NOT NULL THEN RETURN NEW;
 END IF;
 IF OLD.status='APPROVED' AND NEW.status='EXECUTED'
   AND NEW.approved_by=OLD.approved_by AND NEW.reviewed_at=OLD.reviewed_at
   AND NEW.executed_at IS NOT NULL THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Invalid supplier refund approval transition';
END $$;
CREATE TRIGGER supplier_refund_request_transition_guard BEFORE UPDATE OR DELETE ON supplier_refund_requests
 FOR EACH ROW EXECUTE FUNCTION supplier_refund_request_guard();

CREATE OR REPLACE FUNCTION guard_phase4_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_total bigint; credit_total bigint; qty_total bigint; tax_total bigint; refunded_total bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted financial documents are immutable'; END IF;
 IF TG_TABLE_NAME='purchase_bills' THEN
   IF (to_jsonb(NEW)-'paid_paisa'-'credited_paisa'-'returned_qty'-'refunded_paisa')
     IS DISTINCT FROM (to_jsonb(OLD)-'paid_paisa'-'credited_paisa'-'returned_qty'-'refunded_paisa') THEN
     RAISE EXCEPTION 'Posted purchase bill fields cannot be changed';
   END IF;
   SELECT coalesce(sum(amount_paisa),0) INTO paid_total FROM supplier_payments
     WHERE company_id=NEW.company_id AND bill_id=NEW.id;
   SELECT coalesce(sum(supplier_credit_paisa),0),coalesce(sum(quantity),0)
     INTO credit_total,qty_total FROM purchase_returns
     WHERE company_id=NEW.company_id AND bill_id=NEW.id;
   SELECT coalesce(sum(amount_paisa),0) INTO refunded_total FROM supplier_refund_receipts
     WHERE company_id=NEW.company_id AND bill_id=NEW.id;
   IF NEW.refunded_paisa<>refunded_total THEN
     RAISE EXCEPTION 'Supplier refund total must equal immutable bank receipt history';
   END IF;
   IF NEW.paid_paisa<>paid_total OR NEW.credited_paisa<>credit_total OR NEW.returned_qty<>qty_total THEN
     RAISE EXCEPTION 'Purchase bill paid and credit amounts must match immutable history';
   END IF;
   IF NEW.credited_paisa<OLD.credited_paisa OR NEW.returned_qty<OLD.returned_qty
     OR NEW.paid_paisa<OLD.paid_paisa OR NEW.refunded_paisa<OLD.refunded_paisa THEN RAISE EXCEPTION 'Purchase settlement totals cannot decrease'; END IF;
 ELSE
   IF (to_jsonb(NEW)-'paid_paisa'-'credited_net_paisa'-'credited_tax_paisa'-'gross_amount_paisa')
     IS DISTINCT FROM (to_jsonb(OLD)-'paid_paisa'-'credited_net_paisa'-'credited_tax_paisa'-'gross_amount_paisa') THEN
     RAISE EXCEPTION 'Posted vehicle invoice fields cannot be changed';
   END IF;
   SELECT coalesce(sum(amount_paisa),0) INTO paid_total FROM vehicle_sales_payments
     WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
   SELECT paid_total-coalesce(sum(amount_paisa),0) INTO paid_total FROM vehicle_refund_disbursements
     WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
   SELECT coalesce(sum(net_paisa),0),coalesce(sum(tax_paisa),0)
     INTO credit_total,tax_total FROM vehicle_credit_notes
     WHERE company_id=NEW.company_id AND invoice_id=NEW.id;
   IF NEW.paid_paisa<>paid_total OR NEW.credited_net_paisa<>credit_total
     OR NEW.credited_tax_paisa<>tax_total THEN
     RAISE EXCEPTION 'Vehicle invoice paid and credited amounts must match immutable payment/credit history';
   END IF;
   IF NEW.credited_net_paisa<OLD.credited_net_paisa OR NEW.credited_tax_paisa<OLD.credited_tax_paisa THEN
     RAISE EXCEPTION 'Vehicle credit totals cannot decrease';
   END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
