CREATE TABLE "public"."ledger" (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  amount numeric NOT NULL,
  note text
);

CREATE TABLE other (
  id bigserial PRIMARY KEY,
  note text
);

CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  -- A ';' inside the body does not end the statement: GRANT UPDATE ON ledger TO nobody;
  RAISE EXCEPTION 'ledger is append-only';
END;
$$ LANGUAGE plpgsql;
