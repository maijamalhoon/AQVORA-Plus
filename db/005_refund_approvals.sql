-- AQVORA Plus Phase 6: dual-control price-refund authorization and immutable cash-out source.
-- Requires all prior migrations; no existing records are rewritten.
BEGIN;
ALTER TABLE document_sequences DROP CONSTRAINT document_sequences_code_check;
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_code_check
 CHECK(code IN ('SO','JC','SI','PI','VI','PR','CN','DL'));

CREATE TABLE vehicle_refund_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 invoice_id uuid NOT NULL,
 credit_net_paisa bigint NOT NULL CHECK(credit_net_paisa>0),
 credit_tax_paisa bigint NOT NULL DEFAULT 0 CHECK(credit_tax_paisa>=0),
 refund_amount_paisa bigint NOT NULL CHECK(refund_amount_paisa>0),
 request_date date NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 8 AND 2000),
 client_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'PENDING'
  CHECK(status IN ('PENDING','APPROVED','REJECTED','EXECUTED')),
 requested_by uuid NOT NULL REFERENCES app_users(id),
 approved_by uuid REFERENCES app_users(id),
 reviewed_at timestamptz,
 executed_at timestamptz,
 credit_note_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(credit_net_paisa+credit_tax_paisa=refund_amount_paisa),
 CHECK(requested_by IS DISTINCT FROM approved_by),
 CHECK(
  (status='PENDING' AND approved_by IS NULL AND reviewed_at IS NULL AND executed_at IS NULL AND credit_note_id IS NULL)
  OR (status='REJECTED' AND approved_by IS NOT NULL AND reviewed_at IS NOT NULL AND executed_at IS NULL AND credit_note_id IS NULL)
  OR (status='APPROVED' AND approved_by IS NOT NULL AND reviewed_at IS NOT NULL AND executed_at IS NULL AND credit_note_id IS NULL)
  OR (status='EXECUTED' AND approved_by IS NOT NULL AND reviewed_at IS NOT NULL AND executed_at IS NOT NULL AND credit_note_id IS NOT NULL)
 ),
 FOREIGN KEY(company_id,invoice_id) REFERENCES vehicle_sales_invoices(company_id,id),
 FOREIGN KEY(company_id,credit_note_id) REFERENCES vehicle_credit_notes(company_id,id),
 UNIQUE(company_id,id),UNIQUE(company_id,client_key),
 UNIQUE(company_id,credit_note_id)
);
CREATE INDEX refund_requests_queue_idx ON vehicle_refund_requests(company_id,status,created_at DESC);

ALTER TABLE vehicle_credit_notes ADD COLUMN refund_request_id uuid;
ALTER TABLE vehicle_credit_notes ADD CONSTRAINT refund_request_company_fk
 FOREIGN KEY(company_id,refund_request_id) REFERENCES vehicle_refund_requests(company_id,id);
CREATE UNIQUE INDEX one_credit_note_per_refund_request
 ON vehicle_credit_notes(company_id,refund_request_id) WHERE refund_request_id IS NOT NULL;

CREATE TABLE vehicle_refund_disbursements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 request_id uuid NOT NULL,
 invoice_id uuid NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa>0),
 refund_date date NOT NULL,
 voucher_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,request_id) REFERENCES vehicle_refund_requests(company_id,id),
 FOREIGN KEY(company_id,invoice_id) REFERENCES vehicle_sales_invoices(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,request_id), UNIQUE(company_id,voucher_id)
);
CREATE INDEX vehicle_refunds_by_invoice ON vehicle_refund_disbursements(company_id,invoice_id);

CREATE FUNCTION refuse_refund_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Posted vehicle refund history is immutable'; END $$;
CREATE TRIGGER posted_refund_protect BEFORE UPDATE OR DELETE ON vehicle_refund_disbursements
 FOR EACH ROW EXECUTE FUNCTION refuse_refund_history_change();

CREATE FUNCTION guard_refund_request_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Refund requests cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'status'-'approved_by'-'reviewed_at'-'executed_at'-'credit_note_id')
   IS DISTINCT FROM (to_jsonb(OLD)-'status'-'approved_by'-'reviewed_at'-'executed_at'-'credit_note_id') THEN
   RAISE EXCEPTION 'Refund request details are immutable';
 END IF;
 IF OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED')
   AND NEW.approved_by IS NOT NULL AND NEW.approved_by<>OLD.requested_by
   AND NEW.reviewed_at IS NOT NULL THEN RETURN NEW;
 END IF;
 IF OLD.status='APPROVED' AND NEW.status='EXECUTED'
   AND NEW.approved_by=OLD.approved_by AND NEW.reviewed_at=OLD.reviewed_at
   AND NEW.executed_at IS NOT NULL AND NEW.credit_note_id IS NOT NULL THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Invalid refund approval state transition';
END $$;
CREATE TRIGGER refund_request_transition_guard BEFORE UPDATE OR DELETE ON vehicle_refund_requests
 FOR EACH ROW EXECUTE FUNCTION guard_refund_request_transition();

-- Original payment records stay append-only. Net collected = deposits less immutable refunds.
-- Both the refund voucher and its sale credit note must be posted in one transaction.
CREATE OR REPLACE FUNCTION guard_phase4_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_total bigint; credit_total bigint; qty_total bigint; tax_total bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted financial documents are immutable'; END IF;
 IF TG_TABLE_NAME='purchase_bills' THEN
   IF (to_jsonb(NEW)-'paid_paisa'-'credited_paisa'-'returned_qty')
     IS DISTINCT FROM (to_jsonb(OLD)-'paid_paisa'-'credited_paisa'-'returned_qty') THEN
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
   IF NEW.credited_paisa<OLD.credited_paisa OR NEW.returned_qty<OLD.returned_qty
     OR NEW.paid_paisa<OLD.paid_paisa THEN RAISE EXCEPTION 'Purchase settlement totals cannot decrease'; END IF;
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
