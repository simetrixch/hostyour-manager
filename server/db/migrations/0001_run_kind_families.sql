-- Every run kind carries its family: the cluster-*, consumer-* and tenant-* spellings replace the
-- bare ones (shared/enums.ts RUN_KIND). `runs.kind` is a plain text column with no CHECK, so the
-- literals in that list are not symbols — they are VALUES already written into rows. Renaming them
-- in the code alone would leave every stored run filed under a spelling nothing in the code knows,
-- and the run screen's filters would answer empty on the runs an operator is looking for.
--
-- A DATA migration, not a schema change: no table, column, index or constraint moves here, which is
-- why the baseline stays the schema and this file sits beside it rather than inside it.
--
-- TWO stored places carry a run kind, and both are rewritten in the one statement below:
--   * `runs.kind`, the column every read and every filter goes through;
--   * `runs.plan_json -> '$.kind'`, the frozen plan the operator approved. Leaving that behind would
--     have the plan of a run disagree with the run's own row. Rows whose plan_json is NULL (a run
--     still planning) or holds a rejection report with no `kind` (a streaming plan that failed
--     validation) carry no run kind there and are matched by neither branch.
--   `plan_json.planHash` is deliberately NOT recomputed: nothing verifies it — it is written once
--   into the run.approved audit detail and never read back — and a hash silently recomputed over
--   changed content would claim a verification this platform does not perform.
--
-- The `audit` table is NOT touched, and could not be: its rows carry the kind of a run in
-- `detail_json` as it was spelled when the run was planned, and the audit_no_update trigger aborts
-- any UPDATE. That is the point of an append-only record — it says what was true then.
--
-- IDEMPOTENT: the rewrite is driven by a table of (old, new) pairs and matches only rows still
-- carrying an old spelling, so a second run matches nothing. No new spelling appears on the left of
-- any pair, so no row can be rewritten twice into a third name.
-- LOSES NO ROW: one UPDATE, no DELETE and no table rebuild — every row that was there is there
-- afterwards, and only the one field it carried a run kind in has changed.
WITH renamed(old_kind, new_kind) AS (VALUES
  ('adopt', 'cluster-adopt'),
  ('deploy-slave', 'cluster-deploy-slave'),
  ('redeploy', 'cluster-redeploy'),
  ('release', 'cluster-release'),
  ('tailnet-disconnect', 'cluster-tailnet-disconnect'),
  ('tailnet-reconnect', 'cluster-tailnet-reconnect'),
  ('tailnet-rejoin', 'cluster-tailnet-rejoin'),
  ('password-login-disable', 'cluster-password-login-disable'),
  ('password-login-enable', 'cluster-password-login-enable'),
  ('operator-key-place', 'cluster-operator-key-place'),
  ('operator-key-remove', 'cluster-operator-key-remove'),
  ('authorized-keys-read', 'cluster-authorized-keys-read'),
  ('onboard', 'consumer-onboard'),
  ('suspend', 'consumer-suspend'),
  ('resume', 'consumer-resume'),
  ('offboard', 'consumer-offboard'),
  ('purge', 'consumer-purge'),
  ('adopt-consumer', 'consumer-adopt'),
  ('restart-workloads', 'consumer-restart-workloads'),
  ('set-size', 'consumer-set-size'),
  ('backup', 'consumer-backup'),
  ('restore', 'consumer-restore'),
  ('migrate', 'consumer-migrate'),
  ('create-tenant', 'tenant-create'),
  ('add-app', 'tenant-add-app'),
  ('remove-app', 'tenant-remove-app'),
  ('check-tenants', 'tenant-check')
)
UPDATE runs
SET
  kind = COALESCE((SELECT new_kind FROM renamed WHERE old_kind = runs.kind), runs.kind),
  plan_json = CASE
    WHEN plan_json IS NOT NULL AND json_valid(plan_json)
         AND json_extract(plan_json, '$.kind') IN (SELECT old_kind FROM renamed)
    THEN json_set(plan_json, '$.kind', (SELECT new_kind FROM renamed WHERE old_kind = json_extract(plan_json, '$.kind')))
    ELSE plan_json
  END
WHERE kind IN (SELECT old_kind FROM renamed)
   OR (plan_json IS NOT NULL AND json_valid(plan_json)
       AND json_extract(plan_json, '$.kind') IN (SELECT old_kind FROM renamed));
