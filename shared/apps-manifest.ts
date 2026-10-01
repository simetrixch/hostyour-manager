// apps.yaml — the manifest at the root of an apps repository: one entry per app folder, with the
// title and the description a person reads and the SELECTIONS the wizard offers for it. The
// platform knows an app through this file and through nothing else: no chart overlay per app, no
// list in the Manager, no field in the wizard that names a selection. The deploy repository's apps bundle
// carries one today; a tenant's own apps repository carries one of its own (hostyour-manager#174).
//
// Import boundary: shared/ is isomorphic. The web reads the TYPES here; the parser is the server's.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { appDatabases, appName, siteId } from "./tenant.ts";

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

/** ONE app of the bundle. `name` is the folder, and the member name the tenant deploys it as, so it
 *  carries the app-name grammar of the registration. `databases` is the list of databases the app
 *  opens, which the engine's ServiceClaim grants; the deploy repository's manifest says WHERE it goes through
 *  the `{databases}` token (tenant-fanout.ts), and an entry without one leaves that to the chart's
 *  own value files. An entry that lists `sites` is a website folder: it is deployed once per
 *  website, each named by its own domain and serving one of these sites (TenantAppSchema). */
export const AppEntrySchema = z.object({
  name: appName,
  title: z.string().min(1),
  description: z.string().default(""),
  selections: z.record(selectionName, AppSelectionSchema).default({}),
  databases: appDatabases.optional(),
  sites: z.array(siteId).min(1).refine((s) => new Set(s).size === s.length, { message: "a site is listed once" }).optional(),
});
export type AppEntry = z.infer<typeof AppEntrySchema>;

/** THE ENGINE A BUNDLE IS WRITTEN FOR: the build it runs on and that build's version line, the first
 *  two numbers of a version. A breaking change of the engine's app contract starts a new line, so a
 *  tenant runs the bundle only beside that build on that line (server/domains/units/engine-line.ts).
 *  Quoted, because YAML reads `0.3` as a number and `0.10` as `0.1`. */
export const AppsEngineSchema = z.object({
  build: z.string().regex(/^[a-z0-9-]+$/, "a build name is lower-case letters, digits and hyphens"),
  line: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/, "a version line is the first two numbers of a version, quoted, such as \"0.3\""),
});
export type AppsEngine = z.infer<typeof AppsEngineSchema>;

/** A path inside the catalog, relative to its root (`handbook`, `docs/drafts`): segments of letters,
 *  digits, `.`, `_` and `-`, none empty and none `.` or `..`, so it cannot name anything outside it. */
const catalogPath = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "a catalog path is relative to the catalog's root, such as handbook or docs/drafts")
  .refine((path) => !path.split("/").some((segment) => segment === "." || segment === ".."), { message: "a catalog path has no . or .. segment" });

export const AppsManifestSchema = z.object({
  apps: z.array(AppEntrySchema),
  engine: AppsEngineSchema.optional(),
  /** The paths that stay in the catalog and never reach a tenant's repository, such as its handbook.
   *  The run that writes a tenant's repository leaves each one out (tenant-apps-tree.ts). */
  catalogOnly: z.array(catalogPath).optional(),
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
    throw new Error(`${APPS_MANIFEST_PATH} does not match the apps manifest shape (apps[]: name, title, description, selections{title, default}, databases?, sites?; engine?{build, line}; catalogOnly?[path]): ${why}`);
  }
  return parsed.data;
}

/** One app of a tenant's own bundle, as its apps.yaml declares it, and whether the tenant deploys it:
 *  `deployed` is the registration's apps[], the list the tenants ApplicationSet fans out over. The
 *  tenant page offers the undeployed ones to tenant-add-app and marks the rest. */
export interface TenantCatalogAppView extends AppEntry {
  deployed: boolean;
}

/** One website of a tenant: its app name, the site it serves, and the domain it is served at. */
export interface TenantWebsiteView {
  name: string;
  site: string;
  domain: string;
}

/** GET /api/tenants/:id/app-catalog — a READ, and it degrades the way the orphan scan does: `apps`
 *  alone is the answer only while neither field below is set. `reason` names why there is no catalog
 *  to read BY DESIGN (tenant onboarding not wired, no catalog reader, a tenant not onboarded);
 *  `error` means the read itself failed (the template's clone failed, its apps.yaml does not parse),
 *  so `apps: []` says NOTHING and the page must show the error, never "the catalog offers no app". Declared beside the entry it extends rather than in
 *  api-types.ts, which stands at the file-size budget. */
export interface TenantAppCatalogView {
  apps: TenantCatalogAppView[];
  /** The tenant's websites, off its registration: each app that names a domain. Absent where
   *  the tenant has none. */
  websites?: TenantWebsiteView[];
  /** The name of every member the tenant has, off its registration: its standing members and its apps,
   *  websites included. A new website is named clear of these and of the catalog's apps. */
  members?: string[];
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
