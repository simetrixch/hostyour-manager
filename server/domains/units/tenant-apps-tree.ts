// The tree of a tenant's own apps repository, composed from the catalog's apps bundle — the TEMPLATE
// (hostyour-manager#177): every file of the template except the release kit, which the build-only
// onboarding injects, and the app folders the tenant did not choose; a manifest of the tenant's own,
// naming its unit and its one build; and an apps.yaml carrying the chosen entries as the template
// spells them. The three composers of the unit's names stand here too, so the run, the registration
// and the tests spell `<bundle>-<subdomain>` from one place.
//
// Boundary: a domain module over the two git PORTS (a reader for the template, a writer's file read
// for the standing repository). Nothing here clones, commits or opens a credential; the run does.
import { parseDocument, stringify as stringifyYaml, isMap, isSeq } from "yaml";
import { APPS_MANIFEST_PATH } from "../../../shared/apps-manifest.ts";
import { CONSUMER_MANIFEST_PATH, ConsumerManifestSchema } from "../../../shared/consumer.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import { errValidation } from "../../kernel/errors.ts";
import { RELEASE_KIT_DIR, RELEASE_KIT_WORKFLOW } from "#unit/server/release-kit/release-kit.ts";

/** A tenant's apps unit: `<bundle>-<subdomain>` — the catalog's template name (tenant.appsBundle,
 *  the product the bundle is an instance of) carrying the tenant's subdomain (hostyour-manager#216).
 *  The unit IS the repository name and the image name (the identity law: manifest name == repo name
 *  == unit, and a build name is a flat image name), so one composer answers all three. */
export function tenantAppsUnit(bundle: string, subdomain: string): string {
  return `${bundle}-${subdomain}`;
}

/** The repository the App creates in the owner the catalog names: `<org>/<bundle>-<subdomain>`. */
export function tenantAppsRepoURL(org: string, bundle: string, subdomain: string): string {
  return `https://github.com/${org}/${tenantAppsUnit(bundle, subdomain)}.git`;
}

export interface TreeFile {
  path: string;
  content: string;
}

/** Every file of the template that belongs in a tenant's repository, read through the reader. Left
 *  out: the git directory; the release kit (inject-release-kit writes the current kit, and a copied
 *  one would be replaced a step later); the two files this run composes (the manifest, apps.yaml);
 *  and the folder of every app of the template the tenant did not choose. */
export async function readTemplateTree(repo: RepoReader, workdir: string, input: { templateApps: readonly string[]; chosen: readonly string[] }): Promise<TreeFile[]> {
  const unchosen = new Set(input.templateApps.filter((a) => !input.chosen.includes(a)));
  const skipped = new Set([".git", RELEASE_KIT_DIR, RELEASE_KIT_WORKFLOW.path, APPS_MANIFEST_PATH, CONSUMER_MANIFEST_PATH, ...unchosen]);
  const out: TreeFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await repo.listDir(workdir, dir)) {
      const path = dir === "" ? name : `${dir}/${name}`;
      if (skipped.has(path)) continue;
      const content = await repo.readFile(workdir, path);
      if (content === null) {
        // A name the reader cannot read as a file is a directory (the reader answers null for one).
        await walk(path);
        continue;
      }
      // ponytail: the reader serves TEXT. A byte git stores that is not UTF-8 arrives here as U+FFFD
      // and would be written back changed — refused by name rather than copied wrong. A binary asset
      // in the bundle needs a git-native copy on the RepoWriter port.
      if (content.includes("�")) throw errValidation(`${path} of the template is not UTF-8 text — this run copies text files only and would corrupt it`);
      out.push({ path, content });
    }
  };
  await walk("");
  return out;
}

/** The tenant repository's own deploy/platform.yaml: a BUILD-ONLY unit named after the tenant, with
 *  the one build the tenant's engines mount, built the way the template's bundle is built. Parsed
 *  back through the manifest schema before it is handed out, so the file the repository carries is
 *  one the onboarding will accept. */
export function tenantAppsManifest(input: { unit: string; owner: string; envs: readonly Stage[]; containerfile: string; context?: string | undefined }): string {
  const manifest = {
    apiVersion: "hostyour.cloud/v1",
    kind: "ConsumerManifest",
    name: input.unit,
    owner: input.owner,
    envs: [...input.envs],
    builds: [{ name: input.unit, containerfile: input.containerfile, ...(input.context ? { context: input.context } : {}) }],
    // The pipeline's word that this build's pin is the tenant registration (shared/consumer.ts).
    appsBundle: input.unit,
  };
  ConsumerManifestSchema.parse(manifest);
  return stringifyYaml(manifest);
}

/** The name an apps.yaml entry carries, or undefined for an item that is not a map with one. */
function entryName(item: unknown): string | undefined {
  if (!isMap(item)) return undefined;
  const name = item.get("name");
  return typeof name === "string" ? name : undefined;
}

/** The apps.yaml the tenant's repository carries after this run: the entries it carries today (none
 *  on a fresh repository, where the template's file with its header stands in) plus every chosen
 *  entry of the template it lacks, copied as the template spells it — comments included. NEVER
 *  removes an entry: an app the tenant added by hand, or chose in an earlier run, stays. `added`
 *  names what was appended, in template order; empty means the file is left as it stands. */
export function mergeAppsManifest(template: string, current: string | null, chosen: readonly string[]): { content: string; added: string[] } {
  const templateDoc = parseDocument(template);
  const templateApps = templateDoc.get("apps");
  if (!isSeq(templateApps)) throw errValidation(`${APPS_MANIFEST_PATH} of the template carries no apps list`);
  const templateItems = [...templateApps.items];
  const doc = current === null ? templateDoc : parseDocument(current);
  const apps = doc.get("apps");
  if (!isSeq(apps)) throw errValidation(`${APPS_MANIFEST_PATH} of the repository carries no apps list — refusing to rewrite a file this run did not shape`);
  if (current === null) apps.items = [];
  const have = new Set(apps.items.map(entryName));
  const added: string[] = [];
  for (const item of templateItems) {
    const name = entryName(item);
    if (name === undefined || !chosen.includes(name) || have.has(name)) continue;
    apps.items.push(item);
    added.push(name);
  }
  return { content: doc.toString(), added };
}
