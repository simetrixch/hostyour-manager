-- tenants.routing: how a tenant's members are addressed below its zone (MEMBER_ROUTING). Added by ADD
-- COLUMN, which SQLite accepts on a table that holds rows because the column carries a DEFAULT (the
-- #229 shape is NOT NULL without one): every standing row reads `host`, the addressing it was created
-- under.
ALTER TABLE `tenants` ADD `routing` text DEFAULT 'host' NOT NULL;