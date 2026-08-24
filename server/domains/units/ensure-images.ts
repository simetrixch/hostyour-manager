// The tenant ensure-images gate. The tenant fan-out deploys ONLY pre-built images from the registrations
// its cluster pulls from (zot on the cluster's build plane) — a registration written while a pinned
// image is missing fans out straight into ImagePullBackOff. This module closes that gap in three
// pieces, all consumed by create-tenant AND add-app:
//
//   1. collectContainerImages — the pure extraction: every containers[]/initContainers[] `image:`
//      across the validated render's docs (validate-tenant.ts feeds it and surfaces the result on
//      its outcome).
//   2. requiredImagesFrom — the pure policy: filter to the cluster's registry host and split each
//      ref into <repo>:<tag>.
//   3. ensureImagesStep — the Step both runs insert BEFORE any pointer/project mutation: probe
//      every required image and fail the run naming every one that is absent.
//
// It is a PROBE, never a builder: images are produced by each unit's own release pipeline, so a
// tenant whose images are not built is not a tenant to create.
//
// Boundary: a domain module — it depends only on the registry-probe PORT (never its impl), the helm
// port's RenderedDoc type, and the executor Step type.
import { z } from "zod";
import type { Step } from "../../executor/types.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { RegistryProbe } from "../../adapters/registry/port.ts";
import { errValidation } from "../../kernel/errors.ts";

/** One image the pinned fan-out requires from the cluster's registrations. Frozen into the run params at
 *  plan time, so the set cannot move between plan and execute. */
export const RequiredImageSchema = z.object({
  repo: z.string().min(1), // the path after the registry host, e.g. "example-engine"
  tag: z.string().min(1), // the bare tag after ':', e.g. "0.29.0"
});
export type RequiredImage = z.infer<typeof RequiredImageSchema>;

/** Every `image:` under a containers[]/initContainers[] list anywhere in the rendered docs —
 *  a recursive walk, so nested pod templates (Deployment/StatefulSet/CronJob) are all covered
 *  without a kind table. Deduped + sorted (a stable set for params/report assertions). */
export function collectContainerImages(docs: readonly RenderedDoc[]): string[] {
  const images = new Set<string>();
  for (const doc of docs) walk(doc.raw, images);
  return [...images].sort();
}

function walk(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const rec = node as Record<string, unknown>;
  for (const key of ["containers", "initContainers"]) {
    const list = rec[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const image = (entry as { image?: unknown } | null)?.image;
      if (typeof image === "string" && image.length > 0) out.add(image);
    }
  }
  for (const value of Object.values(rec)) walk(value, out);
}

/** Project the collected image strings to the RequiredImage set for ONE registry host: only
 *  `<registryHost>/...` refs are ours to check (docker.io/ghcr.io base images are upstream's),
 *  split into repo + tag (an untagged ref probes the pull default "latest"; a digest-pinned ref
 *  probes the digest). Deduped on repo:tag. */
export function requiredImagesFrom(images: readonly string[], registryHost: string): RequiredImage[] {
  const byRef = new Map<string, RequiredImage>();
  for (const image of images) {
    if (!image.startsWith(`${registryHost}/`)) continue;
    const ref = image.slice(registryHost.length + 1);
    const at = ref.lastIndexOf("@");
    let repo: string;
    let tag: string;
    if (at >= 0) {
      // <repo>@sha256:... — the /v2 manifests endpoint probes a digest just like a tag.
      repo = ref.slice(0, at);
      tag = ref.slice(at + 1);
    } else {
      const slash = ref.lastIndexOf("/");
      const colon = ref.lastIndexOf(":");
      const hasTag = colon > slash;
      repo = hasTag ? ref.slice(0, colon) : ref;
      tag = hasTag ? ref.slice(colon + 1) : "latest"; // the pull default — still probed, never assumed
    }
    if (repo.length === 0 || tag.length === 0) continue;
    byRef.set(`${repo}:${tag}`, { repo, tag });
  }
  return [...byRef.values()];
}

/** The one ensure port — a structural subset of TenantOnboardPorts, so both runs pass their ports
 *  object straight through. */
export interface EnsureImagesPorts {
  registryProbe: RegistryProbe;
}

/** The params slice the step reads — a structural subset of CreateTenantParams AND AddAppParams.
 *  Dereferenced only inside run() (steps() is also called with empty params for the name listing). */
export interface EnsureImagesParams {
  requiredImages: readonly RequiredImage[];
  /** The registry host the tenant charts pull from (`zot.<build-plane>`, the target cluster's own). */
  registryHost: string;
}

/** The shared ensure-images Step. Inserted BEFORE apply-appproject/write-pointer in create-tenant
 *  and add-app: onboarding must never fan out to an image that does not exist. Read-only — it
 *  probes and reports, so a resume simply probes again. */
export function ensureImagesStep(ports: EnsureImagesPorts, p: EnsureImagesParams): Step {
  return {
    name: "ensure-images",
    title: "Check the fan-out's registrations images exist",
    run: async (ctx) => {
      const registryHost = p.registryHost;
      const required = p.requiredImages;
      if (required.length === 0) {
        ctx.log("meta", `the validated render pulls no ${registryHost} image — nothing to check`);
        return;
      }
      // Probe every pinned image. An undecidable probe throws (fail-closed, port contract). Every
      // image is probed before the verdict, so one run names the WHOLE missing set instead of
      // sending the operator round the loop one tag at a time.
      const missing: RequiredImage[] = [];
      for (const img of required) {
        const exists = await ports.registryProbe.imageExists({ registryHost, repo: img.repo, tag: img.tag }, { signal: ctx.signal });
        ctx.log("meta", `${img.repo}:${img.tag} is ${exists ? "present" : "MISSING"} in ${registryHost}`);
        if (!exists) missing.push(img);
      }
      if (missing.length > 0) {
        throw errValidation(
          `missing image(s) in ${registryHost}: ${missing.map((m) => `${m.repo}:${m.tag}`).join(", ")} — ` +
            `release each one through its own unit's release pipeline, then retry`,
        );
      }
      ctx.checkpoint({ required: required.length });
      ctx.log("meta", `all ${required.length} required image(s) present in ${registryHost}`);
    },
  };
}
