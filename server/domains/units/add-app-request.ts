import { z } from "zod";
import { appName, isWebsiteAppNameOf, siteId, websiteAppName } from "../../../shared/tenant.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { ownDomainEntryProblem } from "#unit/shared/unit-host.ts";

/** The raw operator request from the add-app wizard: the target tenant + the new app name. */
export const AddAppRequest = z.object({
  tenantId: z.string().startsWith("tnt_"),
  app: appName,
  // The app's selections, in the shape of one create-tenant apps[] entry (TenantAppSchema): the
  // two seed tiers as fields, every further selection the catalog declares under selections. T4
  // holds all of them against the app's catalog entry.
  seedReference: z.boolean().default(false),
  seedDemo: z.boolean().default(false),
  selections: z.record(z.string(), z.boolean()).default({}),
  // A website names all three (TenantAppSchema): the folder it runs, the site it serves and is named
  // after, and the domain, typed without `www.`, that it is served at.
  folder: appName.optional(),
  site: siteId.optional(),
  domain: publicFqdn.optional(),
  // The website becomes the tenant's main website, served at `/` of the tenant's domain.
  main: z.boolean().default(false),
}).superRefine((r, ctx) => {
  const given = [r.folder, r.site, r.domain].filter((v) => v !== undefined).length;
  if (given !== 0 && given !== 3) ctx.addIssue({ code: "custom", path: ["domain"], message: "a website names its folder, its site and its domain" });
  if (r.main && given === 0) ctx.addIssue({ code: "custom", path: ["main"], message: "only a website can be the main website: it names its folder, its site and its domain" });
  if (r.site !== undefined && !isWebsiteAppNameOf(r.app, r.site)) {
    ctx.addIssue({ code: "custom", path: ["app"], message: `a website of site ${r.site} is named ${websiteAppName(r.site, new Set())}, or that name with -2, -3 and on where it is taken, never ${r.app}` });
  }
  if (r.domain === undefined) return;
  const typed = ownDomainEntryProblem(r.domain);
  if (typed !== null) ctx.addIssue({ code: "custom", path: ["domain"], message: typed });
});
export type AddAppRequest = z.infer<typeof AddAppRequest>;
