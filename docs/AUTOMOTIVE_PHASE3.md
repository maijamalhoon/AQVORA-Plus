# AQVORA Plus — Automotive Operations Phase 3

This is an **original, independent** dealership management implementation. It is not affiliated with CIBS/DealerPro. The connected Dealer Pro reference showed an unauthorized page for some operations, so feature equivalence here is based on authorized visible navigation and common dealership workflow requirements, **not copied vendor code or data**.

## Working operational slices

| Area | Implemented | Important limitations |
|---|---|---|
| CRM | Company-scoped customers and owned vehicles | No document attachments or full CRM campaign tools |
| Vehicle Sales | Vehicle stock catalogue, reservations, cancellation and available-stock restoration | No vehicle sales invoices, delivery notes, registration fees, COGS or payment plans |
| Service | Job Card creation; OPEN → IN_PROGRESS → COMPLETED | No appointment scheduler, estimates, technician timesheets or labor rate cards |
| Spares | Parts master, GRN-style receipt, parts issue to open jobs, no-negative-stock rule, immutable stock movement log | Does not yet post inventory asset value, supplier AP or cost of sales; last purchase cost is informational |
| Finance | Completed-job **labor-only** invoice, Dr AR / Cr Service Revenue; bank collection Dr Bank / Cr AR | No tax calculation, parts billing, credit notes, invoice reversal or customer refunds |
| Reporting | Company-scoped outstanding service invoice aging and GL/trial balance | Aging is based on **current balance**, not historical as-of snapshots; other DealerPro reports remain planned |

## Security and accounting notes

- API roles enforced on server: SALES creates vehicle bookings, SERVICE handles jobs, PARTS handles stock movements, FINANCE handles invoices/settlements; ADMIN can access all.
- All mutable operational APIs use company-scoped foreign keys and authorization checks. Transactions and row locks guard stock reservations, stock decrement and invoice overpayment.
- Database history for stock movements and invoice payments is append-only; posted GL lines remain immutable.
- Generic voucher reversal is **blocked** for source-linked service invoice and payment vouchers, pending a dedicated credit note/refund workflow.
- Duplicate GRN/stock references for the same part/movement/job cannot post twice.
- Service invoice financial postings require an open fiscal period and configured AR/Service Revenue accounts; settlement requires open period and configured Bank/AR accounts.
- No employee or dealership production data, and no unauthorized page access, are needed for development/testing.
- This is not production-ready until backup/restore, MFA, authorization hardening, invoice and inventory reconciliation, reporting and operational UAT are complete.

## Getting started

Requirements: Node.js 22+, PostgreSQL 15+, isolated AQVORA Plus database.

1. Install dependencies with npm install.
2. Set DATABASE_URL to the dedicated AQVORA Plus database.
3. Run npm run db:migrate. The migration runner applies 001 then 002, and recognizes a complete old Phase 2 database.
4. For a fresh database, set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, then run npm run db:bootstrap and clear the password from the environment.
5. Start with npm start and open http://localhost:3000.
6. Use fake test data only. Run npm test and npm run check.

AQVORA ERP is a separate repository and is unaffected. PR #3 is stacked on PR #2 and should be reviewed only after PR #2.
