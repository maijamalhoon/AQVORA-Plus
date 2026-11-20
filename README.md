# AQVORA Plus

An **independent dealership management system (DMS)** project, separate from AQVORA ERP.

## Goal

Build equivalent externally observable DealerPro business workflows using original source code and different AQVORA Plus branding. Neither CIBS source code, artwork, nor private customer records may be copied. AQVORA Plus is **not affiliated with CIBS / DealerPro**.

## Verified reference and scope

The connected DealerPro account displayed a Sales-scope navigation tree, including Order Form, Sales Note, Cash/Bank/JV vouchers, General Ledger, Trial Balance, Aging, Sales Reports, Chart of Accounts, CRM and Administration. An earlier Service-scope menu displayed appointments, jobs, service invoices, parts and stock operations. The active page displayed **UnAuthorized Access**. Only the visible menu structure was inspected: internal fields and server-side rules have not been verified.

See [the parity inventory](docs/DEALER_PRO_PARITY.md).

## Stage 1 — accounting domain prototype

The repository contains an isolated, dependency-free **demo journal engine** in `src/domain/journal.mjs`, with tests in `test/journal.test.mjs`. It validates balanced double-entry postings using integer paisa, derives a trial balance and provides append-only reversal entries.

```bash
npm test
```

This is not a production system: no database, login, role-based permissions, approvals, atomic storage, tax, real vouchers or tenant isolation. **Never enter company financial information.**

## Next implementation slices

1. Verified screen-by-screen workflow specification and permission matrix.
2. Original responsive application shell; company/department navigation and master data.
3. Server-side authentication, company/branch isolation, immutable journal ledger and transactional posting.
4. Accounts, receivables, payables, bill settlement, aging and bank reconciliation.
5. Service, workshop, spare parts, procurement, sales lifecycle and reporting.
6. Accountant QA, backups, security testing, role UAT and release hardening.

The complete experimental browser-only UI source is prepared separately for review; this first PR commits the independently testable accounting domain and reference inventory first.
