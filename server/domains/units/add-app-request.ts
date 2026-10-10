import { z } from "zod";
import { appName, isWebsiteAppNameOf, siteId, websiteAppName } from "../../../shared/tenant.ts";

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
  // A website names both (TenantAppSchema): the folder it runs, and the site it serves and is named after.
  folder: appName.optional(),
  site: siteId.optional(),
  // The website becomes the tenant's main website, served at `/` of the tenant's host.
  main: z.boolean().default(false),
}).superRefine((r, ctx) => {
  const given = [r.folder, r.site].filter((v) => v !== undefined).length;
  if (given === 1) ctx.addIssue({ code: "custom", path: ["site"], message: "a website names its folder and its site" });
  if (r.main && given === 0) ctx.addIssue({ code: "custom", path: ["main"], message: "only a website can be the main website: it names its folder and its site" });
  if (r.site !== undefined && !isWebsiteAppNameOf(r.app, r.site)) {
    ctx.addIssue({ code: "custom", path: ["app"], message: `a website of site ${r.site} is named ${websiteAppName(r.site, new Set())}, or that name with -2, -3 and on where it is taken, never ${r.app}` });
  }
});
export type AddAppRequest = z.infer<typeof AddAppRequest>;
