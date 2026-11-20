-- AQVORA Plus dealership operational workflows. Requires 001_initial.sql.
BEGIN;

CREATE TABLE document_sequences(
 company_id uuid NOT NULL REFERENCES companies(id),
 code text NOT NULL CHECK(code IN ('SO','JC','SI')),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 last_number integer NOT NULL DEFAULT 0 CHECK(last_number>=0),
 PRIMARY KEY(company_id,code,period)
);

CREATE TABLE customers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 140),
 phone text CHECK(phone IS NULL OR length(phone) BETWEEN 6 AND 35),
 email text,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id)
);
CREATE INDEX customers_company_name_idx ON customers(company_id,name);

CREATE TABLE customer_vehicles(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 customer_id uuid NOT NULL,
 registration text NOT NULL CHECK(length(trim(registration)) BETWEEN 2 AND 40),
 chassis text NOT NULL CHECK(length(trim(chassis)) BETWEEN 4 AND 80),
 model text NOT NULL CHECK(length(trim(model)) BETWEEN 2 AND 140),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
 UNIQUE(company_id,id),
 UNIQUE(company_id,chassis)
);

CREATE TABLE vehicle_stock(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 chassis text NOT NULL CHECK(length(trim(chassis)) BETWEEN 4 AND 80),
 variant text NOT NULL CHECK(length(trim(variant)) BETWEEN 2 AND 140),
 color text,
 list_price_paisa bigint NOT NULL CHECK(list_price_paisa>0),
 status text NOT NULL DEFAULT 'IN_STOCK' CHECK(status IN ('IN_STOCK','RESERVED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,chassis)
);

CREATE TABLE sales_bookings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 customer_id uuid NOT NULL,
 vehicle_id uuid NOT NULL,
 agreed_price_paisa bigint NOT NULL CHECK(agreed_price_paisa>0),
 status text NOT NULL DEFAULT 'BOOKED' CHECK(status IN ('BOOKED','CANCELLED')),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 cancelled_at timestamptz,
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
 FOREIGN KEY(company_id,vehicle_id) REFERENCES vehicle_stock(company_id,id),
 UNIQUE(company_id,id),
 UNIQUE(company_id,reference)
);
CREATE UNIQUE INDEX one_active_booking_per_vehicle
 ON sales_bookings(company_id,vehicle_id) WHERE status='BOOKED';

CREATE TABLE service_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 vehicle_id uuid NOT NULL,
 complaint text NOT NULL CHECK(length(trim(complaint)) BETWEEN 3 AND 2000),
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','COMPLETED')),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 FOREIGN KEY(company_id,vehicle_id) REFERENCES customer_vehicles(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,reference)
);

CREATE TABLE parts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 sku text NOT NULL CHECK(length(trim(sku)) BETWEEN 2 AND 50),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 140),
 unit_cost_paisa bigint NOT NULL DEFAULT 0 CHECK(unit_cost_paisa>=0),
 stock_qty integer NOT NULL DEFAULT 0 CHECK(stock_qty>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,sku)
);

CREATE TABLE stock_movements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 part_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('RECEIPT','ISSUE')),
 quantity integer NOT NULL CHECK(quantity>0),
 unit_cost_paisa bigint NOT NULL CHECK(unit_cost_paisa>=0),
 reference text NOT NULL CHECK(length(trim(reference)) BETWEEN 2 AND 120),
 job_id uuid,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,part_id) REFERENCES parts(company_id,id),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 CHECK((direction='ISSUE' AND job_id IS NOT NULL) OR (direction='RECEIPT' AND job_id IS NULL))
);
CREATE INDEX stock_movements_company_part ON stock_movements(company_id,part_id,created_at DESC);
CREATE UNIQUE INDEX stock_movement_idempotency ON stock_movements(company_id,part_id,direction,reference,job_id) NULLS NOT DISTINCT;

CREATE TABLE service_invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 reference text NOT NULL,
 job_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 invoice_date date NOT NULL,
 due_date date NOT NULL,
 labor_amount_paisa bigint NOT NULL CHECK(labor_amount_paisa>0),
 paid_paisa bigint NOT NULL DEFAULT 0 CHECK(paid_paisa>=0 AND paid_paisa<=labor_amount_paisa),
 voucher_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(due_date>=invoice_date),
 FOREIGN KEY(company_id,job_id) REFERENCES service_jobs(company_id,id),
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,reference), UNIQUE(company_id,job_id), UNIQUE(company_id,voucher_id)
);
CREATE INDEX service_invoices_company_due ON service_invoices(company_id,due_date);

CREATE TABLE service_invoice_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id),
 invoice_id uuid NOT NULL,
 amount_paisa bigint NOT NULL CHECK(amount_paisa>0),
 voucher_id uuid NOT NULL,
 received_at date NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,invoice_id) REFERENCES service_invoices(company_id,id),
 FOREIGN KEY(company_id,voucher_id) REFERENCES vouchers(company_id,id),
 UNIQUE(company_id,id), UNIQUE(company_id,voucher_id)
);

-- Never edit/delete recorded stock movements or service invoice payments.
CREATE FUNCTION reject_operational_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Historical operational records are immutable';
END $$;
CREATE TRIGGER stock_movement_no_change BEFORE UPDATE OR DELETE ON stock_movements
 FOR EACH ROW EXECUTE FUNCTION reject_operational_history_change();
CREATE TRIGGER ar_payment_no_change BEFORE UPDATE OR DELETE ON service_invoice_payments
 FOR EACH ROW EXECUTE FUNCTION reject_operational_history_change();

CREATE FUNCTION service_invoice_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Service invoice cannot be deleted'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
 OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.job_id IS DISTINCT FROM OLD.job_id
 OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
 OR NEW.due_date IS DISTINCT FROM OLD.due_date OR NEW.labor_amount_paisa IS DISTINCT FROM OLD.labor_amount_paisa
 OR NEW.voucher_id IS DISTINCT FROM OLD.voucher_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
 OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'Posted service invoices are immutable';
 END IF;
 IF NEW.paid_paisa<OLD.paid_paisa THEN RAISE EXCEPTION 'Invoice paid amount may not decrease'; END IF;
 IF NEW.paid_paisa IS DISTINCT FROM OLD.paid_paisa AND
    NEW.paid_paisa IS DISTINCT FROM (
      SELECT coalesce(sum(p.amount_paisa),0)
      FROM service_invoice_payments p
      WHERE p.company_id=NEW.company_id AND p.invoice_id=NEW.id
    ) THEN
      RAISE EXCEPTION 'Paid invoice balance must reconcile to immutable payments';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_invoice_protect BEFORE UPDATE OR DELETE ON service_invoices
 FOR EACH ROW EXECUTE FUNCTION service_invoice_change_guard();

-- Prevent manual stock quantity changes from diverging from the immutable movement ledger.
CREATE FUNCTION part_stock_qty_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_stock bigint;
BEGIN
 SELECT coalesce(sum(CASE WHEN direction='RECEIPT' THEN quantity ELSE -quantity END),0)
 INTO expected_stock FROM stock_movements
 WHERE company_id=NEW.company_id AND part_id=NEW.id;
 IF NEW.stock_qty IS DISTINCT FROM expected_stock THEN
   RAISE EXCEPTION 'Part on-hand balance must equal inventory movement history';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER part_stock_qty_check BEFORE UPDATE ON parts
 FOR EACH ROW EXECUTE FUNCTION part_stock_qty_guard();


COMMIT;
