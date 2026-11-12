-- A trigger with a WHEN clause locks only some rows; the table is not append-only.
CREATE TABLE posting (id bigserial PRIMARY KEY, posted boolean NOT NULL DEFAULT false);

CREATE TRIGGER posting_lock
  BEFORE UPDATE OR DELETE ON posting
  FOR EACH ROW WHEN (OLD.posted) EXECUTE FUNCTION ledger_append_only();

GRANT UPDATE, DELETE ON posting TO app;
