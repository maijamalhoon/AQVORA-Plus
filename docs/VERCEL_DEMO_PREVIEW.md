# AQVORA Plus — Vercel Working Preview (Demo Only)

## Project and deployment
- Vercel project: aqvora-plus, team jalvoro-platform.
- Branch: feat/vercel-full-demo-adapter (Preview deployment, never main production).
- Runtime: Express on Node.js through server.mjs. No output-directory override to public; backend functions and the browser UI must deploy together.
- Database: NEW isolated PostgreSQL project with a serverless-compatible TLS pooler. Never use the existing Shop Pro, Yaqoob Enterprises Web, Toyota, or Dealer Pro database.
- Required Vercel environment: DATABASE_URL (encrypted; Preview only). Optional PG_POOL_MAX=2.
- Protect preview deployments with Vercel Authentication.

## Setup steps
1. Create a NEW isolated PostgreSQL project. Obtain its pooled database URL; keep credentials private.
2. Enter DATABASE_URL in Vercel Settings > Environment Variables, Preview scope (branch-specific when possible); add PG_POOL_MAX=2 if desired.
3. From an approved controlled environment, run npm install and npm run db:migrate (migrations 001–009) against ONLY that empty demo database. Vercel requests never auto-run migrations.
4. Bootstrap a fictitious demo company with npm run db:bootstrap and four required BOOTSTRAP_ variables. Never commit demo account secrets or paste DB credentials into chat.
5. The preview endpoint /api/demo-status should report online=true, database=ready, migrationsApplied=9, workingDemo=true.
6. Sign in as Admin, create new Finance/Sales/Service/Parts users under Staff & Permissions, rotate temporary passwords and test all flows with synthetic data.

## Readiness contract
- GET / serves the real AQVORA Plus UI, with a visible notice if database is missing.
- GET /api/demo-status reports database status without returning credentials.
- Authenticated API access remains company scoped; no mock financial backend is substituted.
- When the DB is missing, all business API requests return 503, not a fake success.
- Existing accounting, refunds and BRS PostgreSQL integration tests remain mandatory.
- Production readiness is NO-GO until external finance/security and regulatory requirements pass.

## Notes
Serverless functions do not preserve local disk state across invocations; an external durable PostgreSQL database is required. Importing genuine statements, paying refunds and title transfers are NOT supported production workflows. Keep deployments protected and do not process live financial data.
