-- No credential row per unit (hostyour-manager#226): a unit's repository is reached with its owner's
-- identity, resolved from the URL at every use, so the column that carried a unit's own row goes,
-- and with it the rows themselves — the `github-app` rows storing nothing and the copies of an
-- owner's PAT sealed under a unit's name. The owner's rows and the App's one row stay.
ALTER TABLE `apps` DROP COLUMN `repo_credential_id`;--> statement-breakpoint
DELETE FROM `credentials` WHERE `subject_kind` = 'unit' AND `purpose` = 'repository-identity';
