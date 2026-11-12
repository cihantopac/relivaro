GRANT INSERT ON ledger TO worker; -- expect: sec/sql-grant-append-only
GRANT INSERT (account_id, note) ON ledger TO worker;
GRANT SELECT ON ledger TO reader;
GRANT INSERT ON other TO worker;
GRANT UPDATE, DELETE ON TABLE public.ledger TO admin_role; -- expect: sec/sql-grant-append-only
/* GRANT ALL ON ledger TO everyone; */
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader;
