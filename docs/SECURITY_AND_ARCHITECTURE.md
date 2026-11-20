# Security / implementation guardrails

## Independence
- AQVORA Plus remains separate from AQVORA ERP: independent code repository, secrets, database, deployment and identity boundaries.
- All DealerPro reference material must be viewed through already-authorized user access. Never copy live transactions, personal details, customer accounts, source code, logos or internal APIs.
- Workflow equivalence does not require use of the same vendor stack.

## Production architecture target
- Original responsive frontend and server-side API; backend owns validation and authorization.
- Tenant/Company → Branch → Department/Cost Center; explicit role permission matrix for Sales, Service, Parts, Finance and Admin.
- PostgreSQL or SQL Server with atomic database transactions, period locks, journal line constraints, and unique idempotency keys.
- General Ledger is authoritative; invoices and settlements are linked subledger sources. Reports derive from posted entries, not editable snapshots.
- Journal is append-only. Corrections require traceable reversal transactions and approvals. Every critical mutation emits a server-side audit event.
- Multi-user authentication, least privilege, password policy, MFA for privileged roles, rate limits, safe secret management, and activity monitoring.
- Independent backups and verified restore drills. Financial calculations use integer smallest currency units or fixed-precision decimal.
- Mandatory automated tests for balanced postings, invoice reconciliation, inventory and cost of sales, fiscal periods, concurrent settlement, idempotency and cross-company access.

## Current implementation
This PR includes **only** a local non-persistent accounting domain prototype and menu audit. It does not meet production security requirements and must never hold real customer data.
