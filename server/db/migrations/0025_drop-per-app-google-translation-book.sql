-- The Google translation settings are one entry per tenant now, <stage>/tenants/<guid>/google-translation.
-- The book's rows of the per-app entries, <stage>/tenants/<guid>/google-translation/<app>, name entries
-- no code reads or writes any more, and a tenant purge no longer finds them, so they go.
DELETE FROM `secret_writes` WHERE `entry` LIKE '%/tenants/%/google-translation/%';
