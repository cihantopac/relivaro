CREATE TABLE archive (id bigserial PRIMARY KEY);

CREATE TRIGGER archive_ao
  BEFORE UPDATE OR DELETE ON archive
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
