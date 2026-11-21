# AQVORA Plus — Phase 4 Accounting Controls (Development)

**Independent project:** AQVORA Plus is not AQVORA ERP and is not affiliated with Dealer Pro/CIBS. No proprietary source code, internal vendor endpoints, or real dealership/customer data were used.

## Supported workflows and double-entry

| Source document | Dr | Cr | Status |
| --- | --- | --- | --- |
| Vehicle supplier invoice / stock acquisition | Vehicle Inventory (1020501001) | Supplier AP (2010101001) | Posted in one transaction |
| Parts supplier invoice / receipt | Parts Inventory (1020601001) | Supplier AP (2010101001) | Posted in one transaction |
| Supplier bill payment | Supplier AP (2010101001) | Bank (1020402001) | Posted in one transaction |
| Booked vehicle sale invoice | Customer AR (1020301001) | Vehicle Sales Revenue (4010301001) | Posted in one transaction |
| Vehicle sale cost of goods | Vehicle COGS (5010401001) | Vehicle Inventory (1020501001) | Posted with invoice |
| Customer vehicle-sale collection | Bank (1020402001) | Customer AR (1020301001) | Posted in one transaction |
| Accounted service-job parts issue | Parts Consumption/COGS (5010501001) | Parts Inventory (1020601001) | Posted in one transaction |

Service labor invoices and their collections from Phase 3 continue to post separately.

### Important boundaries

- **Sales invoices are not vehicle registration or legal delivery documentation.** Taxes, financing plans, insurance, discounts, deposits, warranty, delivery order and credit notes are not yet implemented.
- **Parts receipts are single-line supplier bills** with quantities and one part number per bill. Multi-line purchase orders/GRNs, supplier discounts, tax treatment, vendor returns and freight allocation remain to be built.
- **Parts valuation** uses weighted-average carrying value for financially accounted inventory. When issuing N units, the amount assigned is rounded to the nearest paisa from total carrying value. The final issue consumes the exact remaining carrying value (no rounding residual).
- **Legacy operational stock** from previous development phases may lack inventory GL entries. It is explicitly blocked from these accounted workflows until opening balances are manually reconciled and migrated. There is no silent automatic backfill of GL transactions.
- Existing operational-only stock receipt/issue endpoints reject parts once valuation_mode is POSTED. Production should replace these legacy endpoints entirely after migration.
- The **source-linked voucher reversal** API blocks independent reversal of invoice, payment, acquisition, sale, and stock-cost entries until source-aware credit-note and return workflows exist. Do not bypass those restrictions.
- **Payment idempotency keys** are required for vehicle customer collections and supplier bill payments. Duplicate keys cannot post a second journal.
- **Current reconciliation report** compares posted GL control balances against receivable/payable subledgers and inventory values. It flags uncosted/legacy stock, manual control-account GL entries, and mismatched balances. It is not an independent financial audit nor a historical as-of report.
- The AR aging report includes unpaid service labor and vehicle sale invoices, using the database's current date.
- Supplier/vehicle/parts financial posting is restricted to **ADMIN** or **FINANCE** role at the backend. Viewing is permission-scoped. No protected Dealer Pro routes were accessed.

## Setup / upgrade

1. Use a **dedicated AQVORA Plus** PostgreSQL 15+ database.
2. Install packages with npm install.
3. Run npm run db:migrate. It applies the third versioned migration without replaying previous migrations.
4. For a **new** company, use the project's documented bootstrap process. For an **existing** company, set PHASE4_COMPANY_CODE to its code and run npm run db:controls to create missing control accounts without resetting admin credentials.
5. Confirm an OPEN fiscal period exists for the posting month. The bootstrap only opens its current UTC month.
6. Run npm run check and npm test, including PostgreSQL integration tests.
7. Run npm start and open the development UI. Use invented test data only.

**Do not deploy for real money before** independent accounting review, tenant/security penetration tests, safe invoice/cancellation handling, approvals, tax compliance, backup/restore drills, idempotent receipt reconciliation, and accounting cutover.

## Financial reconciliation acceptance criteria

An all-green result requires:
- AR GL debit control balance equals unpaid service and vehicle customer invoices.
- AP GL credit control balance equals unpaid supplier purchase bills.
- Vehicle Inventory GL equals acquisition costs of unsold accounted stock.
- Parts Inventory GL equals total carrying value of accounted available parts stock.
- No unresolved legacy vehicle/parts stock in inventory history.

Manual posted transactions to control accounts may intentionally cause differences; investigate, do not force the report green.
