-- The deploy repository's two names that stand frozen in the runs table (hostyour-manager#280).
-- The runs that write into the deploy repository keep its URL in their params and claim its books
-- branch as a lock, in the plan and, once approved, in run_locks. The params key is `deployRepoUrl`
-- and the lock `deploy@<books>` now. Without this, a run planned before the rename fails to parse at
-- its approval, its execution or its abort, and its lock does not exclude a run planned after it on
-- the same branch.
--
-- Only a run that can still act is rewritten: a succeeded or cancelled run is a record and keeps what
-- it froze. planHash stays the fingerprint the plan was frozen with; nothing recomputes it.
UPDATE `runs`
  SET `params_json` = json_set(json_remove(`params_json`, '$.catalogRepoUrl'), '$.deployRepoUrl', json_extract(`params_json`, '$.catalogRepoUrl'))
  WHERE `status` NOT IN ('succeeded', 'cancelled') AND json_type(`params_json`, '$.catalogRepoUrl') IS NOT NULL;--> statement-breakpoint
UPDATE `runs`
  SET `plan_json` = replace(`plan_json`, '"key":"catalog@', '"key":"deploy@')
  WHERE `status` NOT IN ('succeeded', 'cancelled') AND instr(`plan_json`, '"key":"catalog@') > 0;--> statement-breakpoint
UPDATE `run_locks`
  SET `key` = 'deploy@' || substr(`key`, 9)
  WHERE `resource` = 'git-branch' AND substr(`key`, 1, 8) = 'catalog@';
