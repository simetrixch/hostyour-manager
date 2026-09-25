-- HAND-EDITED after `npm run db:generate`, by the owner's decision on #264 (Q-A). drizzle-kit wrote
-- `DROP TABLE `unit_sizes`;` here, because the table left the core's schema: the unit plugin declares it
-- now (plugins/unit/server/schema.ts) and migrates it under its own ledger, __drizzle_migrations_unit.
-- Dropping it would destroy the sizes this installation sells. This migration exists for its snapshot,
-- which no longer carries unit_sizes, so the core's next generate does not take the table for its own.
-- The statement below changes nothing: the table and its rows stay where the baseline created them.
SELECT 1;
