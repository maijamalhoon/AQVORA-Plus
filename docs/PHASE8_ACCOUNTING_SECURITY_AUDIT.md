# AQVORA Plus — Phase 8 accounting and security audit

**Scope:** Code review of AQVORA Plus Draft PRs #1–#7, emphasizing the most recent server APIs and source-linked accounting workflows. No access to Dealer Pro internal/proprietary pages, no production datasets, no changes to the standalone AQVORA ERP.

## Confirmed problems addressed in this draft

**A. Manual control-account posting could bypass subledgers (high integrity risk).**
- Before this change, FINANCE/ADMIN users could create and post generic vouchers to trade receivables, trade payables, vehicle stock, spare-parts inventory or sales-tax control accounts, even though those amounts are expected to reconcile to structured invoices, payments and inventory movements.
- The reconciliation report would show differences after the fact, but could not prevent them.
- The API now blocks these codes for new manual vouchers and checks pre-existing draft vouchers again before a manual posting.
- The special financial workflows that create an invoice/receipt/return still post to the control accounts through a documented source ledger. No posted data is rewritten.

**B. Invalid request shapes could trigger HTTP 500 (input hardening).**
- Posting an invalid manual voucher previously allowed validation exceptions to escape as generic server errors; null login JSON could trigger property access exceptions.
- Invalid voucher payloads now receive HTTP 400. Null or array-shaped login payloads are rejected without crashing the server.
- No database migration is needed for either fix.

## Reserved control-account policy

| Account code | Source-controlled balance | Allowed source |
| --- | --- | --- |
| 1020301001 | Accounts Receivable | Vehicle/service invoice, collection, authorized customer credit/refund |
| 2010101001 | Accounts Payable | Supplier bill, settlement, vendor return/refund |
| 1020501001 | Vehicle Inventory | Recorded vehicle acquisition and booked sale COGS |
| 1020601001 | Parts Inventory | Accounted receipt/issue/return and cost valuation |
| 2010201001 | Sales Tax Liability | Configured vehicle tax and valid credit-note reversal |

**Not automatically protected:** Bank and general expense/revenue/capital accounts. An ordinary JV can still record a bank transfer or approved adjustment, where the app does not currently have an authoritative bank reconciliation subledger.

### Controls verified in code and automated tests
- Tenant-scoped membership selection on authenticated API requests.
- Role-based checks on financial/approval operations.
- SQL transactions + row locks on source account postings.
- Generic voucher reversals blocked when linked to invoices, inventory movements, purchase returns or refunds.
- Posted journal immutability enforced by database triggers.
- All new financial entries use integer paisa and account-specific posting.
- New tests prove manual reserved-code posting is rejected, including previously created drafts, while regular JVs still work.

### Outstanding risks — do not deploy to real dealerships
1. **Bank statement verification is manual**, not independently matched; the app cannot confirm refund money truly arrived or left a bank.
2. Approval permissions are basic ADMIN vs FINANCE roles; no monetary signing thresholds per approver, hardware MFA, delegated signer limits, approval evidence attachment or bank beneficiary screening.
3. The app's database connection has write access to all company tables. Stronger database tenant/RLS boundaries, least-privilege roles and external security assessment are needed.
4. The system includes fixed GL control codes and currently lacks a governed source-control account configuration/migration plan for a custom chart of accounts.
5. Backups/restore, full statutory tax compliance, opening balance conversion, inventory lot tracing, complete automotive delivery/title workflows, full vehicle returns and end-to-end production reconciliation remain unfinished.
6. There is no independent runtime production security review or volume testing. Passing CI demonstrates only tested code paths, not complete correctness.

## Reviewer acceptance criteria
1. Run `npm run check` and all unit/PostgreSQL tests on a dedicated AQVORA Plus development database.
2. Confirm that manually drafted/post requests using each reserved account return 409 and do not change posted GL.
3. Confirm that previously created draft with a reserved account cannot be posted via the generic endpoint.
4. Confirm a normal balanced expense vs bank JV still posts and can be reconciled/reversed.
5. Confirm earlier automotive/purchase/return/refund transaction tests stay green after this change.
6. Obtain an accountant's approval for reserved code list, and a security review before merging or deploying.

**Stacked PR order:** Base PR #1 → #2 → #3 → #4 → #5 → #6 → #7 → #8. Keep Draft; no merge, no production rollout, no actual money movement.
