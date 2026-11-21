# AQVORA Plus

**Independent dealership management system** built separately from the AQVORA Enterprise ERP. The product target is equivalent, observed Dealer Pro business workflows, implemented from scratch with distinct branding. Not affiliated with CIBS or Dealer Pro.

## Phase 8: Source-controlled ledger safety audit (Draft PR #8)

**Critical accounting safeguard:** General-purpose manual vouchers now reject posting against the source-controlled trade AR, trade AP, vehicle inventory, spare-parts inventory, and sales-tax GL accounts. These account balances must be changed through their company-scoped invoice, settlement, purchase, return, stock or credit-note workflows so subledgers remain auditable.

The restriction applies at **manual draft creation and manual posting of historic drafts**. System-generated, source-linked financial documents continue using their dedicated journal paths. Ordinary general-journal expenses and other non-reserved accounts remain supported.

Malformed logins and voucher validation now produce clear **400 Bad Request** responses rather than generic server failures. PostgreSQL-backed regression tests cover malformed input, role/tenant isolation, reserved-account rejection, legacy draft posting and unchanged ordinary JV behavior.

See [Phase 8 audit and unresolved risks](docs/PHASE8_ACCOUNTING_SECURITY_AUDIT.md). **This remains non-production development software** pending finance/security review, migrations, user acceptance testing and merging the preceding stacked PRs.

## Phase 7: Supplier parts return, confirmed bank refund and approval limits (Draft PR #7)

A narrowly-scoped **maker-checker supplier refund** is now available for accounted, fully paid **parts purchase bills without prior returns**.

- **Admin** sets a company-level maximum per supplier refund. No policy means no refund can be requested or executed. Lowering the limit also blocks already-approved but unexecuted requests above the new amount.
- **Finance** requests a parts return/refund with a documented reason. The request records the invoice-based credit value and requires original parts stock to remain on hand.
- A **different Admin** approves or rejects the request. Finance records a separately verified **bank receipt reference** before executing it.
- Execution atomically posts: supplier return Dr AP / Cr Parts Inventory (plus any moving-average Purchase Price Variance) and supplier refund receipt Dr Bank / Cr AP. It also updates stock quantity/value, immutable supplier-return records, refund receipts, bill refund/credit totals and the audit log.
- **AP Aging and reconciliation** include bank refunds alongside posted invoices, purchase returns and supplier payments.
- New supplier refund approval queue and audit screens; automated PostgreSQL tests for dual authorization, per-company limits, duplicate prevention and balanced accounting.

**Financial/operational limitations:** The system records the bank receipt entered by Finance; it does **not** contact a bank or confirm funds. The returned quantity is deducted from pooled weighted-average stock; there is no lot-specific physical return verification. Only fully paid parts bills with no earlier returns qualify. Partially paid invoice returns with refunds, vehicle purchases, full vehicle returns, supplier payments to account for advances, government tax compliance and live settlement integrations are still pending. Never enter actual customer/supplier banking data or use real money in this prototype.

See [Phase 7 supplier refund controls](docs/PHASE7_SUPPLIER_REFUNDS.md). PR #7 stacks on PR #6 and requires full review before merge or deployment.

## Phase 6: Dual-control vehicle price refunds and source audit (Draft PR #6)

This original implementation supports a **narrow, traceable customer refund** when a vehicle sale invoice was already paid and the dealership later agrees to a partial price reduction.

1. A **FINANCE** user requests a documented net price credit on an existing paid vehicle invoice.
2. A **different ADMIN** reviews and explicitly **APPROVES** or **REJECTS** the pending request. The requester can never approve their own adjustment.
3. A **FINANCE** user executes an approved request. In one database transaction the app posts Bank Credit / Customer AR Debit for cash refunded, issues the linked vehicle price-adjustment credit note (Revenue Debit and applicable Tax Control Debit / AR Credit), updates net collected amounts, and writes an immutable refund audit trail.
4. The Refund Audit screen detects unposted refund vouchers and missing request → disbursement → credit note links.

**Important:** The single bootstrap ADMIN account cannot execute this workflow alone. You need at least two independent, correctly provisioned people (Finance requester/executor and Admin approver). This is intentionally a **four-eyes control**.

**Scope exclusions:** This does NOT implement full vehicle return, legal title reversal, after-sale cancellations, physical stock return, customer bank-account validation, actual bank disbursement integration or supplier refunds. A posted refund is a book entry indicating disbursement; transfer confirmation and bank statement reconciliation remain external responsibilities. Do NOT use with real money or real customer data until independent security/accounting/operations review.

[Phase 6 refund controls and limitations](docs/PHASE6_REFUND_APPROVALS.md). This PR stacks on PR #5; merge all earlier reviewed PRs first.

## Phase 5: Tax snapshots, returns, credit notes, vehicle delivery and reporting (Draft PR #5)

**Original company-scoped workflows, not vendor source replication:**

- **Tax code register:** Admin creates permanent jurisdiction-verified tax codes in basis points. Vehicle sales invoices snapshot a selected rate and post Dr Accounts Receivable / Cr Sales Tax Control separately. No default statutory rate or official tax-filing assumption.
- **Supplier parts returns:** Only unreturned quantities in accounted purchase bills. Returns debit Supplier AP, credit weighted-average Parts Inventory, and separately recognize any purchase-price variance. Only unpaid supplier amounts may be credited (cash refunds are not built).
- **Vehicle credit notes:** Unpaid price adjustments only. Dr Vehicle Revenue / Cr AR, with proportional Dr Sales Tax Control / Cr AR when a configured tax exists. This is **not** a physical vehicle return, cancelled invoice or refund.
- **Vehicle handover records:** Sales/Admin may issue one immutable delivery note for a fully settled vehicle invoice. The handover is not vehicle registration or a legal title transfer.
- **Reports:** Current AP Aging, tax accrual/GL comparison, vehicle gross margin and updated AR Aging/control reconciliation. The reports are not certified financial statements and do not create statutory tax filings.
- **Safety:** Source-linked voucher reversal remains blocked, no cross-company document references, posted source tables are append-only, duplicate idempotency keys are rejected, and accounting happens atomically with source changes.

See [Phase 5 workflow limitations](docs/PHASE5_WORKFLOWS.md). Start with fake demo data only; the code has not undergone external financial/security assurance. Production deployment, company data imports and merges are **not** part of this PR. Review stacked PR #1 → #2 → #3 → #4 → #5 in dependency order.

## Phase 4: Accounted purchasing, vehicle invoicing and financial controls (Draft PR #4)

The next stacked branch introduces:
- Supplier master, purchase bills and supplier settlements posted to Accounts Payable.
- Vehicle acquisition inventory and booked vehicle invoices with revenue and COGS postings.
- Parts purchases, weighted-average inventory costing, financially posted parts issues to service jobs, and exact carrying-value allocation.
- Vehicle sales invoice collections, combined vehicle/service AR aging, and control-account reconciliation.
- Additional security guards: source-linked journal reversal restrictions, legacy inventory segregation, payment idempotency keys, and transactional posting.
- Frontend screens for invoice and purchase documents, inventory valuation and reconciliation.

**Not production ready.** The work is still pending credit notes, purchase returns, full tax and financing, dealership delivery/legal forms, order/GRN multi-line flows, source-adjustments, historic inventory migrations and full reports. Do not enter production data.

See [Phase 4 accounting controls](docs/PHASE4_FINANCIAL_CONTROLS.md). After PR #2 and #3 are reviewed/merged, review PR #4.

## Phase 3: Automotive operations and receivables (Draft PR #3)

This stacked development branch adds working **customer master, customer vehicles, new-vehicle stock, sales reservations, service job cards, parts receipts/issues, labor-only service invoices, customer payments and current AR aging**. The new browser screens are role-aware, backed by separate company-scoped PostgreSQL tables and server routes. Stock reservation and stock decrement use row-locked transactions; invoice/receipt operations post balanced journals in the same database transaction.

**Still missing for full Dealer Pro parity:** sales invoice and delivery accounting, purchase order/GRN-to-AP integration, parts billing and inventory cost/COGS posting, full tax, credit notes, approval matrix, workshop estimates and comprehensive reports. This remains a **non-production development build**. Do not import production dealership or customer records.

See [Automotive Phase 3](docs/AUTOMOTIVE_PHASE3.md) and [Dealer Pro feature inventory](docs/DEALER_PRO_PARITY.md).

## Phase 2: Database-backed financial foundation

Implemented in this branch:
- PostgreSQL schema for companies, user memberships, Sales/Service/Parts/Finance departments, accounts, fiscal periods, sequences, vouchers, lines and audit records.
- Server-side login with scrypt password hashes, hashed session tokens, HTTP-only cookies, and company/role membership checks on each financial request.
- Cash Book Receipt, Cash Book Payment, Bank Book Receipt, Bank Book Payment, and Journal Voucher workflows: create draft, post, append-only reversal.
- Balanced posting validation, automated monthly voucher numbers, period locking and immutable posted lines.
- General Ledger, Trial Balance, voucher register/details, audit trail and original responsive browser UI.
- Automated domain and PostgreSQL-backed integration tests with GitHub Actions.

**NOT PRODUCTION READY:** no invoice/stock integration, attachments, enterprise approval workflows, self-service account administration, secure backup/restore, full department functionality, or operational hardening. Some Sales, Service and Parts workflows are implemented in Phase 3; remaining unavailable workflows are clearly marked Planned. Never import dealership production or customer data into this test build.

## Start locally

Requires Node.js 22+ and a NEW, dedicated PostgreSQL 15+ database. Never point at the AQVORA ERP database.

1. npm install
2. Set DATABASE_URL in your environment, e.g. postgres://postgres:password@localhost:5432/aqvora_plus
3. npm run db:migrate (version-tracked, applies migrations 001–003; compatible with a complete Phase 2 installation).
4. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ characters), optionally BOOTSTRAP_COMPANY_CODE and BOOTSTRAP_COMPANY_NAME.
5. npm run db:bootstrap (fresh company only; re-running resets its admin password)
6. Remove bootstrap password from your environment.
7. npm start — open http://localhost:3000
8. npm run check and npm test (Postgres integration enabled with DATABASE_URL).

Only the bootstrap month's fiscal period starts OPEN. Other periods must be opened through deliberate administrator-controlled DB operations; posting without an open period is blocked.

## Finance APIs

- POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me
- GET /api/accounts, GET /api/departments
- GET /api/vouchers, POST /api/vouchers, GET /api/vouchers/:id
- POST /api/vouchers/:id/post, POST /api/vouchers/:id/reverse
- GET /api/reports/trial-balance, GET /api/reports/ledger?account=ACCOUNT_CODE
- GET /api/audit and GET /api/health

Mutation requests require X-AQVORA-Request: 1 and same-origin access. Server enforces membership and roles. ADMIN / FINANCE can create/post/reverse; VIEWER can read.

## Deployment & security blockers

Before any actual enterprise use: HTTPS and NODE_ENV=production, managed secret storage, distributed login throttling, multi-factor authentication for administrators, permission administration, auditable approvals, production migration tooling, DB backups with restore drills, threat modeling, cross-company penetration tests, reliable financial reporting, deployment hardening and observability. The in-memory login throttle is only a single-process guard.

Follow docs/DEALER_PRO_PARITY.md for observed reference inventory, docs/AUTOMOTIVE_PHASE3.md for current capabilities, and docs/SECURITY_AND_ARCHITECTURE.md for security guardrails. Review PR #2 before stacking PR #3 onto main.

For existing companies upgrading from Phase 3, configure PHASE4_COMPANY_CODE and run npm run db:controls to install only the new control accounts without changing user credentials.

Phase 5 setup: After migration, ensure control accounts 2010201001 (Sales Tax Control) and 5010601001 (Purchase Price Variance) exist in every upgraded company; run npm run db:controls with PHASE4_COMPANY_CODE set to that company. Tax rates must be established from legally verified local requirements—no official tax defaults are shipped.
