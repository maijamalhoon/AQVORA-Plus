# AQVORA Plus — Phase 11 Bank Reconciliation and Maker-Checker

**Purpose:** Safely explain the difference between what the accounting ledger says and what a manually supplied bank statement says. This phase does not transfer money or post adjusting journals.

## Authorization
- **FINANCE:** import statement batches, choose exact posted Bank GL movements, correct mistaken matches while batch is DRAFT.
- **ADMIN:** read BRS details and finalize a zero-variance batch only after all imported statement lines have been matched.
- SALES, SERVICE, PARTS, VIEWER: no BRS access. Each selected company has its own statement batches, bank transaction identities and matching rights.
- BRS import approver and finalizer are distinct users. A matching event is auditable and match reversal is only allowed before finalization.

## Bank statement CSV format

~~~csv
transaction_id,date,amount,description
BANK-10001,2026-11-20,1000.00,Customer bank deposit
BANK-10002,2026-11-20,-200.00,Cheque payment
~~~

The CSV may be pasted or uploaded from the BRS page. Only synthetic data should be used during testing. Supported fields must be in the exact order shown above; standard CSV quoting is supported. There is currently a maximum of **100 lines** in one statement batch because request bodies are intentionally size-limited.

**Sign convention:** positive amount means bank credit/cash IN; negative amount means bank debit/cash OUT. For Bank GL 1020402001, Debit is IN and Credit is OUT. Matching is exact in integer paisa and does not guess based on descriptions. Statement line IDs must be unique across imported batches for the same bank account.

Statements are chronological: after a batch is finalized, the next imported batch must start on the calendar day immediately after its previous end date and open at the last statement's closing balance. The importer verifies opening plus row movements equals closing. A previous unfinalized statement blocks the next import. No historical statement corrections or re-imports after finalization are supported yet.

## BRS calculation example

- Posted Bank GL balance on the statement cutoff: **PKR 800**.
- Imported Bank statement ending balance: **PKR 1,000**.
- Deposits in transit (posted to Bank GL but not yet cleared): **PKR 0**.
- Outstanding payments/cheques (posted in GL but not yet cleared): **PKR 200**.
- Adjusted Bank: 1,000 + 0 − 200 = **PKR 800**; difference is 0.

The unresolved cheque is carried forward. When the bank shows the −200 clearing in the next statement, Finance matches it to the same historical posted voucher line. The next period's closing Bank GL and Bank statement both become PKR 800. No voucher is double-posted.

## Data integrity and controls

- Company-scoped foreign keys and PostgreSQL constraints enforce unique statement and voucher matches.
- Database trigger checks each match is to the same company, Bank GL account, exact signed amount, POSTED voucher, and voucher date at or before the bank statement cutoff.
- Statement line changes/deletes and finalization rollback are disallowed by database triggers. A Finance user can unmatch only a DRAFT statement line, and this creates an audit event.
- Finalized periods block backdated Bank GL postings. Generic voucher reversal is blocked if any source voucher line is BRS-matched.
- The finalized batch stores its approver identity and the audit event records its key balances.
- No finance values are silently changed; any bank-only transaction requires a separately approved source or general ledger voucher.

## Non-production limitations

**A matched internal BRS does not prove that the imported statement is genuine.** Statement data may be manually altered by its importer. Reliable production use requires certified bank statement import and provenance, trusted bank transaction IDs, opening-balance migration controls, statement storage/authentication, payment confirmation and independent spot checks against a genuine bank feed.

The current implementation matches one bank statement row to one posted Bank GL voucher line; no one-to-many/many-to-one settlements, bulk matching approvals, foreign currency, fee auto-posting, duplicate bank reference remediation, statement re-open, historical start-balance certification, large-statement pagination or multi-bank-account configuration.

Backdated Bank GL postings are blocked after signoff, but the system is still not a legally certified or independently audited bank reconciliation service. A final production deployment requires the broader blockers in docs/RELEASE_READINESS.md and GitHub issue #12.

## Development verification
Use a disposable PostgreSQL test database. Execute:

~~~bash
npm install
npm run check
npm run release:check
npm run db:migrate
npm test
~~~

The dedicated Phase11 integration test verifies import arithmetic, signed matching, outstanding cheque carry-forward, immutable finalization, unique match, cross-company/role access and the no-backdated-posting safeguard.
