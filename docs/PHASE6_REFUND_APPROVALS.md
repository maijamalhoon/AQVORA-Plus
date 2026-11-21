# Phase 6 — Approved vehicle price refunds (Development Only)

AQVORA Plus is separate from AQVORA ERP. This milestone adds one financial control slice without claiming complete Dealer Pro feature parity.

## Transaction semantics

**Price adjustment for an already-paid vehicle sale only.** The refund is always accompanied by a linked credit note in the same PostgreSQL transaction. It cannot serve as a full vehicle return/cancellation. Approval of a refund does not post accounting or send money.

| Step | Actor | Source action | Accounting |
|---|---|---|---|
| Request | FINANCE | Creates immutable refund proposal with customer invoice, net credit, tax snapshot, amount, date, reason and unique idempotency key | None |
| Approve/reject | A different ADMIN | State transition; approval actor and timestamp preserved in history | None |
| Execute | FINANCE | Revalidates invoice/available cash, fiscal posting period and originally approved tax and amounts | Atomic postings below |
| Cash refund | FINANCE, in execute | Immutable refund disbursement source row | Dr Customer AR, Cr Bank |
| Price credit note | FINANCE, in execute | Immutable source-linked credit note | Dr Vehicle Sales Revenue, Cr Customer AR |
| Tax reduction | FINANCE, in execute | Snapshot tax reversal, if applicable | Dr Sales Tax Control, Cr Customer AR |

Net collected cash is stored in vehicle_sales_invoices.paid_paisa and **must equal original immutable collections less immutable disbursements**. Net credited amount and tax must equal original issued credit notes, including this refund-linked credit note.

## Security and controls

- FINANCE submits and executes; **ADMIN approves**, and approval cannot be given by the requester. The approval state is checked under SQL row locks before posting.
- All source queries, foreign keys, and journal entries are restricted to the selected company.
- Duplicate request keys, duplicate decisions, and duplicate executions are rejected.
- Refund amount cannot exceed net collected funds; credit net must be strictly less than the remaining original vehicle net sale amount.
- The requested tax is calculated from the **immutable invoice tax-rate snapshot**, never from today's current tax rate. A changed invoice before execution causes the request to be rejected for a fresh decision.
- A full vehicle return needs an entirely separate physical/ownership/registration/stock reversal workflow. The current feature cannot process one.
- Existing posted vehicle invoices, receipt rows, credit notes and refund disbursements remain append-only. Generic voucher reversal is blocked on cash-refund vouchers and linked credit-note vouchers.
- Request metadata are immutable after creation, while only explicit status, review and execution fields can transition.
- All GL and source mutations occur in one transaction and rollback together on errors.
- The Refund Audit checks request-to-payment-to-note provenance and whether refund vouchers are posted. It is not a replacement for actual bank settlement evidence or bank-statement matching.

## Important limitations

This system does not connect to a bank or actually send money. It assumes a refund has already been authorized and externally processed when a FINANCE user clicks **Post Refund**. For live money operations this requires payment evidence/verification, maker-checker user provisioning, bank-reconciliation automation, payment approval thresholds, MFA, anti-fraud monitoring, and external accounting review before production use.

Full dealership returns, legal ownership restoration, supplier refunds, stock returns linked to sale cancellations, tax refunds, notifications, attachments and signed customer acknowledgments are not in scope.

## Development verification

1. Use a new dedicated PostgreSQL test database; never point development at a real dealership DMS or AQVORA ERP.
2. Run \`npm install\`, \`npm run db:migrate\` (applies migration 005), \`npm run check\` and \`npm test\`.
3. Launch locally with \`npm start\`; sign in with separate ADMIN and FINANCE users.
4. Use invented invoices and fictional parties. Verify full invoice payment, pending request, independent approval, execution and posted GL balances.
5. Keep PR #6 Draft until GitHub Actions/SQL integration passes and finance/security reviews are complete.
