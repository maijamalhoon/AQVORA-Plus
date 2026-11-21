# AQVORA Plus — Development Integration and Release Gate

**Release decision: NO-GO for real dealerships or live money.** The code is an independent AQVORA Plus development DMS, not an authorized Toyota/Dealer Pro substitute and not the standalone AQVORA general ERP. Tests demonstrate selected source-linked transactions, not total enterprise feature parity.

## Stages implemented in source
1. Original demo accounting domain and security architecture.
2. Company accounts, sessions, membership roles, vouchers and double entry.
3. Sales booking, service jobs, parts inventory, service receipts and aging.
4. Supplier invoices, vehicle acquisition and sales/COGS, inventory valuation and GL checks.
5. Tax snapshots, vendor returns, credit notes, vehicle handover and partial reports.
6. Independent admin approval for customer price refunds and immutable source links.
7. Supplier parts refund approvals, per-company caps and AP/stock/Bank accounting.
8. Source-controlled GL account restrictions, malformed-input handling and manual JV UI protection.
9. Create-only company bootstrap, append-only audit history and regression tests for credential/role protection.
10. Admin-only new staff account creation, mandatory initial-password rotation, session revocation and tenant/role permission tests.

## Required quality gate
- Run npm install, npm run check, npm run db:migrate, npm test on an isolated synthetic test DB.
- Run npm run release:check to confirm expected migration, security and test artifacts exist. It reports production_ready:false regardless of unit/integration success.
- Run accounting review for AR/AP/stock/tax/Bank source-to-GL and opening balances as-of every fiscal close.
- Run an independent security review, with tenant isolation, access policy, penetration test, session handling, MFA, rate limiting, backups and data protection.
- Verify operational paths (legal delivery/title, purchase orders and GRN, parts serial/lot origin, workflow approvals, tax compliance, refunds and returns).

## Production blockers
- Current bank receipt/reference entry is manually attested; there is no live bank verification or actual payment integration.
- No provably secure bank beneficiary verification, payment authorization or settlement matching.
- Regulatory tax and legal ownership workflows vary by jurisdiction and are not fully modeled.
- Tenant isolation relies heavily on application queries; database row-level security and least-privilege production DB roles are not complete.
- No tested backup+restore runbook, operational monitoring, audit export and incident response program.
- Mandatory independent finance and security sign-offs are absent.

## Provisioning / bootstrap rules
- npm run db:bootstrap is new-company-only, requires all four environment variables, and fails on duplicate company codes or existing admin email accounts.
- It must not be used as password reset, role elevation or company membership management.
- Create FINANCE/SALES/ADMIN users via a separately reviewed provisioning workflow; bootstrap alone cannot fulfil dual-control refunds.
- All audit events are append-only in PostgreSQL after migration 007.

**PR sequence:** Review and integrate stages in dependency order. A green CI check does not imply this is suitable for production. Only verified sample/development data should be used until a formal go-live approval process is completed.

## Staff provisioning and first login (development)

- Admin can create **new** FINANCE/SALES/SERVICE/PARTS/VIEWER users for their own company. Duplicate emails and assigning existing identities to other companies are intentionally blocked. ADMIN role cannot be created through this basic endpoint.
- Staff receive an out-of-band temporary 14+ character password supplied by the admin. They **must** change it using their own selected password on first login. Every financial/business API remains blocked until the change, and all old sessions are invalidated when it succeeds.
- This is **not a secure emailed invitation system**, nor independent proof the beneficiary is the rightful user. No MFA, mandatory password expiry, recovery/invite tokens, self-service deactivate and access-review approval exist. Administrative staff provisioning remains an operational process requiring independent organizational controls.
