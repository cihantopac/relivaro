CREATE TRIGGER ledger_no_change
  BEFORE DELETE OR UPDATE ON "public"."ledger"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
