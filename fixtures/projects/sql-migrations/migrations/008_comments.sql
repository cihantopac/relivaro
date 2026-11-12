COMMENT ON TABLE ledger IS E'Don\'t; GRANT UPDATE ON ledger TO nobody';
GRANT SELECT ON ledger TO auditor;
GRANT UPDATE ON ledger TO ops GRANTED BY admin;
REVOKE UPDATE ON ledger FROM ops;
GRANT ALL ON ledger TO batch; -- expect: sec/sql-grant-append-only
REVOKE UPDATE, DELETE, TRUNCATE ON ledger FROM batch;
