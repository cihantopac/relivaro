-- Same table name in two schemas: only audit.events is append-only.
CREATE TABLE audit.events (id bigserial PRIMARY KEY);
CREATE TABLE billing.events (id bigserial PRIMARY KEY);

CREATE TRIGGER events_ao
  BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

GRANT INSERT ON billing.events TO app;
GRANT INSERT ON audit.events TO app; -- expect: sec/sql-grant-append-only
