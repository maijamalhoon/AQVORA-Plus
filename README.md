# AQVORA Plus

**Independent dealership management system** built separately from the AQVORA Enterprise ERP. The product target is equivalent, observed Dealer Pro business workflows, implemented from scratch with distinct branding. Not affiliated with CIBS or Dealer Pro.

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
