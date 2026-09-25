-- The credential subject kind 'organisation' becomes 'owner' (hostyour-manager#235): a repository's
-- account on GitHub may be a plain user account, and the agnostic word is GitHub's own. A data
-- migration alone — the column is text, its value set lives in shared/enums.ts CREDENTIAL_SUBJECT.
UPDATE `credentials` SET `subject_kind` = 'owner' WHERE `subject_kind` = 'organisation';
