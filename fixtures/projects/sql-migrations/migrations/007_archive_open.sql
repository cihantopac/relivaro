-- The archive stops being append-only before the grant.
DROP TRIGGER archive_ao ON archive;
GRANT UPDATE, DELETE ON archive TO app;
