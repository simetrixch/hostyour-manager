-- apps.dkim_public_key (hostyour-manager#249): the public half of the DKIM key a mail sender signs the
-- platform domain with, kept on its row by the seed-secrets create that put the private half into
-- Vault. Nullable and without a default, so ADD COLUMN carries a table that holds rows.
ALTER TABLE `apps` ADD `dkim_public_key` text;