# Phase 10 — Account Provisioning and First Login

**Company-scoped development capability:** A company Admin can create a brand-new account for the FINANCE, SALES, SERVICE, PARTS, or VIEWER role. Self-service Admin creation, attaching existing users to another tenant, role escalation or account takeover are not allowed by this endpoint.

## Working flow
1. Log in with the existing company's ADMIN account (bootstrap Admin or an independently provisioned Admin).
2. Open Staff & Permissions. Create a unique email account and set a temporary password of at least 14 characters. Communicate it privately via an approved secure channel. Do not put secrets in support tickets, logs or public chats.
3. Staff sign in with that temporary password. Business APIs are blocked (403) until they choose a new 12–256 character password on the first-login screen.
4. On change, the server verifies the current password, hashes the new password with scrypt, clears the forced-change flag and invalidates all sessions. Staff sign in again with their new private password.
5. Company Admin can view company-scoped members and initial password-change state but cannot view any password or password hash.

## Audit and tests
- STAFF_USER_CREATED event records the acting Admin's ID and new staff ID.
- PASSWORD_CHANGED event records password rotation (never the value).
- Unit/PostgreSQL tests cover admin-only user creation, duplicate/cross-tenant rejection, forced change, old session invalidation, old credential failure, role access and audit history.

## Limits / production blockers
- Admin chooses the initial password and may know it until the staff member rotates it. For real money, use independent identity verification, MFA, email invitation tokens and banking-grade four-eyes policy enforcement.
- This is not a full user-management suite: no Admin creation, suspend/remove membership, active company switching invitations, password reset, email verification, SSO, delegated permissions or device history.
- Real production requires independent authorization and security review and testing. Do not use customer or real bank/dealership data in this prototype.
