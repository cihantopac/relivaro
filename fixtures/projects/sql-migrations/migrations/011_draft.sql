-- Raises only on DELETE and hands the row back otherwise: not append-only.
CREATE TABLE draft (id bigserial PRIMARY KEY);

CREATE FUNCTION draft_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'drafts are kept';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER draft_guard
  BEFORE UPDATE OR DELETE ON draft
  FOR EACH ROW EXECUTE FUNCTION draft_no_delete();

GRANT UPDATE ON draft TO app;
