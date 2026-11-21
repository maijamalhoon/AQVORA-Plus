# AQVORA Plus — Phase 7 Supplier Refunds and Maker-Checker Controls

**Status:** Original standalone DMS development code in Draft PR #7. Not production-ready or affiliated with Dealer Pro/CIBS. AQVORA enterprise ERP is an unrelated system, unchanged.

## Exact supported scenario

This milestone permits a refund from a supplier in connection with returning **physical spare parts** that came from an accounted, fully paid parts bill. The supplier invoice must have no previous returns or credits. The return quantity must remain physically available in the currently pooled parts stock. Lot-specific origin is **not** verified; staff must check physical items and supplier approval separately.

| Phase | Authorized actor | Atomic effect |
|---|---|---|
| Configure maximum | Admin | A non-zero company-specific PKR cap, with audit event |
| Request return/refund | Finance | Immutable request with vendor bill, requested quantity, invoice-derived credit, reason, idempotency token |
| Decide | Independent Admin | APPROVED or REJECTED and reviewer identity/date; never requester |
| Confirm funds and execute | Finance | Records confirmed bank reference, effective receipt/posting date, physical stock return, AP and Bank journals, audit event |
| Report | Finance/Admin | Supplier refund register, source audit, AP Aging, posted GL and inventory controls |

No policy means no request or execution. Reducing the limit after approval blocks execution. A duplicate document, request token, bank reference or execution is rejected.

## Double entries and subledger reconciliation

1. **Return stock to supplier:** Debit Supplier Accounts Payable (2010101001) for original invoice-based credit. Credit Spare Parts Inventory (1020601001) at currently carried weighted-average value. The difference is posted to Purchase Price Variance (5010601001) as a debit or credit as necessary.
2. **Bank refund from supplier:** Debit Bank (1020402001), credit Supplier Accounts Payable (2010101001), equal to the supplier credit.
3. **Subledger:** Original bill's paid_paisa stays unchanged and immutable, credited_paisa increases with the posted return, and refunded_paisa increases by the independently recorded bank receipt. Therefore:
   Open AP = Invoice - Payments - Purchase Returns + Supplier Refund Receipts.
4. **Stock:** Quantity decreases and carrying value reduces by the exact issue cost. All stock movement rows and source journals remain immutable and source-linked.
5. **Reconciliation:** Current AP/parts GL balances must match the source subledgers. Supplier refund audit checks that receipts link to requests and purchase returns, and that bank vouchers are posted. A matched internal audit is **not evidence of actual bank receipt**.

## Control boundaries

- Maker and checker are separate users: FINANCE requests and executes; ADMIN approves or rejects. Authorization is server-side; UI controls are convenience only.
- Finance can execute only after Admin approval. Execution rechecks full payment, remaining purchase quantity, accounted stock, current limit and the receipt date. SQL row locks prevent competing posts.
- Refund records are append-only. Generic voucher reversal is blocked for linked bank receipt and supplier return vouchers.
- Financial accounting is always done in one database transaction so a failure rolls back inventory, AP, Bank and audit entries together.
- The bank reference is typed by Finance. **No bank API, settlement confirmation, statements import, reconciliation match or payment evidence attachment is implemented.** Do not treat this as bank-verified production money movement.
- The system does not support partially paid supplier return refunds, supplier advances, vendor debit notes, vehicle returns, serial/lot-level selection or statutory tax adjustments. Actual company legal/tax return processing still requires domain-specific review.
- Policy management currently permits a single independent Admin to change caps, with an immutable audit event. Production requires approval authority tiers, separate finance administrators, MFA and fraud monitoring.

## Upgrade and verification

1. Work only on the **isolated AQVORA Plus** PostgreSQL test database, not the original AQVORA ERP or a Toyota dealership system.
2. Run npm install, then npm run db:migrate (version 006), then npm run check and npm test.
3. Start locally with npm start. Use independent Admin and Finance test accounts.
4. With fake sample data, configure the maximum, create a paid accounted parts bill, request return, approve, and enter a simulated bank reference. Verify expected AP and Parts Inventory against the posted Trial Balance.
5. Keep Draft PR #7 unmerged until all CI checks pass and qualified accountants/security reviewers verify the transaction and permission design.

Missing for enterprise readiness: full vehicle returns and title reversal, multi-line returns, physical inventory lots, real payment rails, external banking reconciliation, delegated approval tiers, approval attachments, MFA, backups, statutory documents, stress/security testing and production operations.
