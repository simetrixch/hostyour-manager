-- HAND-WRITTEN (drizzle-kit generate --custom): the forward step of CERT_SOLVER for the member rows an
-- installation already holds. seedUnitSizes is create-only, so the grown seed reaches a new database
-- alone; here every standing member row gains one cert-manager solver pod: 10m/64Mi requested,
-- 100m/64Mi at the limit, one pod. CPU is written in millicores and memory in Mi, as the seed's own
-- sums read. ponytail: only a CPU in m or whole cores and a memory in Mi or Gi is understood; a row
-- written in other units stays as it is, and T5 refuses any member that row leaves no solver room.
UPDATE `unit_sizes` SET
  `requests_cpu` = (CAST(ROUND(CASE WHEN `requests_cpu` GLOB '*m' THEN CAST(substr(`requests_cpu`, 1, length(`requests_cpu`) - 1) AS REAL) ELSE CAST(`requests_cpu` AS REAL) * 1000 END) AS INTEGER) + 10) || 'm',
  `limits_cpu` = (CAST(ROUND(CASE WHEN `limits_cpu` GLOB '*m' THEN CAST(substr(`limits_cpu`, 1, length(`limits_cpu`) - 1) AS REAL) ELSE CAST(`limits_cpu` AS REAL) * 1000 END) AS INTEGER) + 100) || 'm',
  `requests_memory` = (CAST(ROUND(CAST(substr(`requests_memory`, 1, length(`requests_memory`) - 2) AS REAL) * (CASE WHEN `requests_memory` GLOB '*Gi' THEN 1024 ELSE 1 END)) AS INTEGER) + 64) || 'Mi',
  `limits_memory` = (CAST(ROUND(CAST(substr(`limits_memory`, 1, length(`limits_memory`) - 2) AS REAL) * (CASE WHEN `limits_memory` GLOB '*Gi' THEN 1024 ELSE 1 END)) AS INTEGER) + 64) || 'Mi',
  `pods` = `pods` + 1,
  `updated_at` = unixepoch('subsec') * 1000
WHERE `component` = 'member'
  AND (`requests_cpu` GLOB '*[0-9]m' OR `requests_cpu` NOT GLOB '*[^0-9.]*')
  AND (`limits_cpu` GLOB '*[0-9]m' OR `limits_cpu` NOT GLOB '*[^0-9.]*')
  AND (`requests_memory` GLOB '*[0-9]Mi' OR `requests_memory` GLOB '*[0-9]Gi')
  AND (`limits_memory` GLOB '*[0-9]Mi' OR `limits_memory` GLOB '*[0-9]Gi');
