-- 007: Preserve event provenance. Audit rows are append-only.
-- Applications must add correction events instead of rewriting history.
BEGIN;
CREATE FUNCTION prevent_audit_history_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit history is immutable; append a new event';
END $$;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_history_rewrite();
COMMIT;
