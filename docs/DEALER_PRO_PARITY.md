# AQVORA Plus — DealerPro parity inventory

**Reference date:** 20 November 2026. **Access:** Authorized read-only connected browser, Sales department role. Current reference page displayed `UnAuthorized Access`, so this inventory reflects only the visible menu tree, not internal pages or source code. An earlier Service-scope menu was also observed. Never attempt to bypass permissions, scrape protected internal data, or clone CIBS assets.

## Navigational inventory — observed

| Area | Visible features | Status in AQVORA Plus |
|---|---|---|
| Sales | Order Form Posting, Sales Note | Planned |
| Finance vouchers | Cash Book, Cash Receipt, Cash Payment, Bank Book, Bank Receipt, Bank Payment, Journal Voucher, Multi Cash, Multi Bank, Payment Advise, Payment Receipt, Bank Reconciliation | Demo journal-domain engine only |
| Accounting reporting | General Ledger, Trial Balance, 6-Column Trial Balance, Audit Trail, Account Activity, Account Summary, Monthly Accounts, Cash Flow, Liquidity | Demo TB calculations only |
| Financial reporting | Income Statement, Balance Sheet, Aging | Planned |
| Vehicle sales reporting | Order Intake, Arrival, Collections, Unsold, Resource Book, Vehicle Purchase, Sales Note, Sale/Purchase, Delivery Order, Undelivered, Work Order, Work Order P&L | Planned |
| Master data and CRM | Chart of Accounts, Tax, Payment Type, Vendor, Cost Center, Customer | Planned |
| Administration | Change Password | Planned |
| Service (earlier role) | Appointments, Estimates, Job Cards, Part Issue/Return, Store Issue, Service Invoices, Day End | Planned |
| Spares (earlier role) | Requisition, Purchase Order, GRN/GRRN, Purchase/Return, Sales/Return, Delivery Challan | Planned |
| Inventory reports (earlier role) | Stock Ledger, Movement, Summary, Aging, Dead Stock, Trends, KPIs | Planned |

## Desired parity criteria

- Same **business functionality** and familiar workflow grouping, implemented from scratch with original code and different brand.
- Field-level UX should be decided only after approved, authorized screen-by-screen observation, test transactions and accounting acceptance criteria.
- Distinct Sales, Service, Parts and Finance access scopes; authenticated server-side role enforcement, never simply a hidden menu.
- Posting should preserve voucher identity, attachments, narration, debit/credit equality, immutable history and reversal links.
- Invoice-to-ledger, settlement, aging, stock valuation, bank reconciliation and reports must agree with reference test fixtures.
- No claims of complete parity until all modules pass accountants' functional acceptance testing.

## Prototype note

`src/domain/journal.mjs` is only an isolated, **non-production** demonstration of double-entry calculations. It deliberately does not manage bank balances, real customers, approvals or persistent data.
