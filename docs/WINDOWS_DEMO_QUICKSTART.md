# AQVORA Plus — Windows CMD Development Quickstart

This runs an independent **development-only demo** against a dedicated PostgreSQL test database. Never connect to the original AQVORA ERP or Toyota/Dealer Pro database and never use real customer, dealership or bank credentials.

## Prerequisites
- Windows 10/11; Node.js **22 or newer**; PostgreSQL **15 or newer**.
- Git clone access to maijamalhoon/AQVORA-Plus.
- A new, empty PostgreSQL database reserved for this prototype; a separate disposable database for running integration tests.

## CMD steps

First clone or download the integration branch, then in the repo folder:

~~~cmd
npm install
set "DATABASE_URL=postgres://LOCAL_USER:LOCAL_PASSWORD@localhost:5432/aqvora_plus_demo"
npm run db:migrate
set "BOOTSTRAP_COMPANY_CODE=LOCAL01"
set "BOOTSTRAP_COMPANY_NAME=AQVORA Plus Local Demo"
set "BOOTSTRAP_ADMIN_EMAIL=admin@example.test"
set "BOOTSTRAP_ADMIN_PASSWORD=YOUR_NEW_STRONG_UNIQUE_PASSWORD"
npm run db:bootstrap
set "BOOTSTRAP_ADMIN_PASSWORD="
npm run check
npm run release:check
npm start
~~~

Open http://localhost:3000. The release gate must say production_ready=false — that is intentional.

Use the Admin login to open **Staff & Permissions** and create a brand-new FINANCE user with a temporary 14+ character password. When the Finance user signs in, they must change the temporary password, sign in again and then use the finance modules. This is basic development onboarding, not verified email or SSO.

## Automated PostgreSQL tests

Tests insert generated synthetic records. **Do not point them at an existing working dealership or demo database you care about.** Use a separate empty disposable database named, for example, aqvora_plus_test. Then:

~~~cmd
set "DATABASE_URL=postgres://LOCAL_USER:LOCAL_PASSWORD@localhost:5432/aqvora_plus_test"
npm run db:migrate
npm test
~~~

You should confirm the migration, unit and PostgreSQL integration suite passes. Then change DATABASE_URL back to your demo DB before running npm start. Use a fresh CMD window for each environment, and keep actual passwords out of your Git repository.

## Troubleshooting
- ECONNREFUSED: PostgreSQL is not running, wrong port or wrong host.
- Database authentication error: verify LOCAL_USER/LOCAL_PASSWORD and database permissions.
- No fiscal posting period: the bootstrap opens the current UTC month; use deliberate SQL/admin operations to open test periods for historical vouchers.
- Duplicate company/user during bootstrap: **expected protection**. Bootstrap is create-only; do not retry with an existing admin email to reset access.
- 403 Change temporary password: sign in as the new staff user, complete first-login password rotation and sign in again.
- Source-controlled account posting rejected: use the invoice/purchase/returns source modules, not a manual JV.

## Non-production boundaries
This app does not send/verify bank transfers, certify statutory taxes, process legal vehicle ownership transfers or provide a complete multi-dealer production security framework. Do not deploy publicly or use real money until independently audited and approved.
