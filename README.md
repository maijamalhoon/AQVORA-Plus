# AQVORA Plus

**Independent dealership management system** built separately from the AQVORA Enterprise ERP. The product target is equivalent, observed Dealer Pro business workflows, implemented from scratch with distinct branding. Not affiliated with CIBS or Dealer Pro.

## Phase 2: Database-backed financial foundation

Implemented in this branch:
- PostgreSQL schema for companies, user memberships, Sales/Service/Parts/Finance departments, accounts, fiscal periods, sequences, vouchers, lines and audit records.
- Server-side login with scrypt password hashes, hashed session tokens, HTTP-only cookies, and company/role membership checks on each financial request.
- Cash Book Receipt, Cash Book Payment, Bank Book Receipt, Bank Book Payment, and Journal Voucher workflows: create draft, post, append-only reversal.
- Balanced posting validation, automated monthly voucher numbers, period locking and immutable posted lines.
- General Ledger, Trial Balance, voucher register/details, audit trail and original responsive browser UI.
- Automated domain and PostgreSQL-backed integration tests with GitHub Actions.

**NOT PRODUCTION READY:** no invoice/stock integration, attachments, enterprise approval workflows, self-service account administration, secure backup/restore, full department functionality, or operational hardening. The Sales, Service and Parts links show honest Planned states. Never import dealership production or customer data into this test build.

## Start locally

Requires Node.js 22+ and a NEW, dedicated PostgreSQL 15+ database. Never point at the AQVORA ERP database.

1. npm install
2. Set DATABASE_URL in your environment, e.g. postgres://postgres:password@localhost:5432/aqvora_plus
3. npm run db:migrate (once on a fresh database).
4. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ characters), optionally BOOTSTRAP_COMPANY_CODE and BOOTSTRAP_COMPANY_NAME.
5. npm run db:bootstrap
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

Follow docs/DEALER_PRO_PARITY.md for reference inventory and docs/SECURITY_AND_ARCHITECTURE.md for architectural guardrails. PR #1 must be integrated before this stacked feature branch can merge into main.
