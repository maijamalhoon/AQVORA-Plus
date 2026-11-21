-- User provisioned with a temporary password must change it before doing work.
BEGIN;
ALTER TABLE app_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
COMMIT;
