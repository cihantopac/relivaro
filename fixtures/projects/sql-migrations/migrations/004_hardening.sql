-- The web role loses its direct insert; entries go through post_entry(), owned by ledger_owner.
REVOKE INSERT ON public.ledger FROM legacy_app;

CREATE FUNCTION post_entry(account bigint, amount numeric) RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO ledger (account_id, amount) VALUES (account, amount);
$$;
ALTER FUNCTION post_entry(bigint, numeric) OWNER TO ledger_owner;

-- A guard that raises only in some cases is not append-only.
CREATE TABLE request (id bigserial PRIMARY KEY, status text NOT NULL);

CREATE FUNCTION guard_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' THEN
    RAISE EXCEPTION 'an open request cannot change';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER request_guard
  BEFORE UPDATE OR DELETE ON request
  FOR EACH ROW EXECUTE FUNCTION guard_request();
