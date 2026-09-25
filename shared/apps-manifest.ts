// apps.yaml — the manifest at the root of an apps repository: one entry per app folder, with the
// title and the description a person reads and the SELECTIONS the wizard offers for it. The
// platform knows an app through this file and through nothing else: no chart overlay per app, no
// list in the Manager, no field in the wizard that names a selection. The catalog's apps bundle
// carries one today; a tenant's own apps repository carries one of its own (hostyour-manager#174).
//
// Import boundary: shared/ is isomorphic. The web reads the TYPES here; the parser is the server's.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { appName } from "./tenant.ts";

/** WHERE an apps repository keeps its manifest — the root, so a bundle built from the repository
 *  and the repository itself describe the same apps. */
export const APPS_MANIFEST_PATH = "apps.yaml";

/** A selection's name is a values key: the engine reads `tenant.apps[].<selection>` for the two it
 *  knows (SEED_SELECTIONS), and a later one is read the same way. One word in camelCase, so it can
 *  stand as a YAML key and as a field of the request without quoting. */
const selectionName = z.string().regex(/^[a-z][A-Za-z0-9]{0,62}$/, "a selection name is one camelCase word");

/** ONE selection an app offers: the title the wizard shows beside its checkbox, and whether the box
 *  starts checked. */
export const AppSelectionSchema = z.object({
  title: z.string().min(1),
  default: z.boolean().default(false),
});
export type AppSelection = z.infer<typeof AppSelectionSchema>;

/** ONE app of the bundle. `name` is the folder and the member name the tenant deploys it as, so it
 *  carries the app-name grammar of the registration. `databases` is the list of databases the app
 *  opens, which the engine's ServiceClaim grants; the catalog manifest says WHERE it goes through
 *  the `{databases}` token (tenant-fanout.ts), and an entry without one leaves that to the chart's
 *  own value files. */
export const AppEntrySchema = z.object({
  name: appName,
  title: z.string().min(1),
  description: z.string().default(""),
  selections: z.record(selectionName, AppSelectionSchema).default({}),
  databases: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).min(1).optional(),
});
export type AppEntry = z.infer<typeof AppEntrySchema>;

export const AppsManifestSchema = z.object({
  apps: z.array(AppEntrySchema),
}).superRefine((m, ctx) => {
  const names = m.apps.map((a) => a.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) {
    ctx.addIssue({ code: "custom", path: ["apps"], message: `two entries are both named "${dup}" — an app's name is its folder and its member name, so the second would land on the first` });
  }
});
export type AppsManifest = z.infer<typeof AppsManifestSchema>;

/** Parse an apps.yaml. THROWS a sentence naming the file and the first issues for a document that
 *  does not parse or does not match the shape, so the plan and the wizard's log say what to fix. */
export function parseAppsManifest(text: string): AppsManifest {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${APPS_MANIFEST_PATH} is not parseable YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = AppsManifestSchema.safeParse(doc);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 6).map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${APPS_MANIFEST_PATH} does not match the apps manifest shape (apps[]: name, title, description, selections{title, default}, databases?): ${why}`);
  }
  return parsed.data;
}

/** One app of a tenant's own bundle, as its apps.yaml declares it, and whether the tenant deploys it:
 *  `deployed` is the registration's apps[], the list the tenants ApplicationSet fans out over. The
 *  tenant page offers the undeployed ones to tenant-add-app and marks the rest. */
export interface TenantCatalogAppView extends AppEntry {
  deployed: boolean;
}

/** GET /api/tenants/:id/app-catalog — a READ, and it degrades the way the orphan scan does: `apps`
 *  alone is the answer only while neither field below is set. `reason` names why there is no catalog
 *  to read BY DESIGN (tenant onboarding not wired, no catalog reader, a tenant not onboarded);
 *  `error` means the read itself failed (the template's clone failed, its apps.yaml does not parse),
 *  so `apps: []` says NOTHING and the page must show the error, never "the catalog offers no app". Declared beside the entry it extends rather than in
 *  api-types.ts, which stands at the file-size budget. */
export interface TenantAppCatalogView {
  apps: TenantCatalogAppView[];
  /** Present where the template's `.npmrc` routes scopes to GitHub Packages: the owner whose reader
   *  the bundle's build installs them with, and whether one is recorded. The add-app form asks for
   *  the token while `recorded` is null — the FIRST tenant onboarding asks, none after (#233). */
  packagesReader?: PackagesReaderView;
  reason?: string;
  error?: string;
}

/** The packages reader an owner's bundles install private packages with: needed for `scopes`,
 *  recorded (fingerprint and date) or not. */
export interface PackagesReaderView {
  owner: string;
  scopes: string[];
  recorded: { fingerprint: string; recordedAt: string } | null;
}
