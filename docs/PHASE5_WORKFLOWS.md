# Phase 5 — Finance Controls and Delivery (non-production)

**AQVORA Plus** is an independent DMS prototype. No Dealer Pro vendor source, protected pages or customer data were copied. All work is in a stacked development branch pending review.

## Implemented postings

| Source | Debit | Credit |
| --- | --- | --- |
| Vehicle sales tax (explicitly selected tax code) | Accounts Receivable | Sales Tax Control |
| Supplier parts return | Supplier Accounts Payable | Parts Inventory |
| Vendor price variance on return | Purchase Price Variance (debit or credit as required) | Balanced within same posting |
| Vehicle price-adjustment credit note | Vehicle Sales Revenue | Accounts Receivable |
| Credit note tax reduction, if configured | Sales Tax Control | Accounts Receivable |

Existing Phase 4 purchasing, vehicle sales revenue/COGS and collection postings remain intact. All postings use integer paisa and double-entry, and all source mutations + journals are in the same PostgreSQL transaction.

**Tax:** Create a new immutable code with verified basis-point rate (e.g. 1500 = 15.00%). The app does not assume any country, province, product classification, exemption or legal rate. It calculates tax on the *net vehicle sale price*, rounds once to nearest paisa, and stores the selected rate snapshot. It does not produce statutory invoices or file returns; taxable parts/service invoices, discounts, tax exemptions, tax withholding, tax remittances, tax registration, tax period closing, input tax and regulatory compliance are not implemented.

**Supplier returns:** Parts must come from an accounted purchase bill and still be in stock. Return quantity must not exceed original purchase less previous returns, and supplier credit must not exceed the unpaid amount. On-hand stock decreases; inventory is relieved at its current weighted-average carrying value. Supplier credit is based on original bill unit cost. The difference is posted to Purchase Price Variance; there is no silent balancing entry. Supplier refunds and a physical goods-return shipping workflow are not implemented. Vehicle supplier returns are not implemented.

**Credit notes:** For vehicle *price corrections only*, Finance can reduce uncollected net invoice amount and (if applicable) matching sales tax. Previously collected money cannot be credited without a separate customer refund process, not built. Credit notes do not return a vehicle, alter COGS, undo booking, or delete a source invoice.

**Delivery:** Sales/Admin can record an immutable handover only when the adjusted invoice has been fully paid and not fully credited. This does not represent government registration, legal ownership transfer, motor insurance issuance, customer signature or actual proof of physical delivery.

**Reporting:** Tax summary compares net configured tax accrual to posted Sales Tax Control. AP Aging subtracts issued vendor credits and payments. AR Aging subtracts vehicle credit notes and payments. Sales margin excludes tax and overheads. Control reconciliation compares current source registers and posted GL, flags unaccounted legacy stock and manual control postings. Reports are operational summaries, not independent audit evidence.

## Upgrade

1. Work against a **dedicated AQVORA Plus** PostgreSQL database, never the AQVORA ERP or Toyota/CIBS database.
2. Back up a development database before applying schema changes.
3. Run \`npm install\`, then \`npm run db:migrate\` (versioned migration 004).
4. For existing company: set \`PHASE4_COMPANY_CODE\` and run \`npm run db:controls\` to add missing Sales Tax Control and Purchase Price Variance accounts. Fresh setup already includes them.
5. Confirm the fiscal posting period is open, then run \`npm run check\` and \`npm test\` against a dedicated PostgreSQL test database.
6. Start locally with \`npm start\`. Create example company tax codes only after checking the correct rate externally with a qualified accountant.

**Not ready for live dealerships:** Needs staff approval matrix, MFA, audit review, exception/error handling, permission hardening, reconciliation at volume, disaster recovery, exact statutory tax rules, partial credit/refund/return controls and regulated document templates. Original AQVORA remains untouched.
