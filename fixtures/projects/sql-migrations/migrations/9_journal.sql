CREATE TABLE journal (id bigserial PRIMARY KEY);

CREATE TRIGGER journal_ao
  BEFORE UPDATE OR DELETE ON journal
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

GRANT UPDATE ON journal TO app;
