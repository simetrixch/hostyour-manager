// The images every tenant holds, as pins for the registry reaper's floor. A tenant runs its own
// version of every build its members render (tenant.approvedTags), which may be older than the last
// versions the reaper keeps by count, and its own apps bundle (appsImage at appsImageTag), which no
// chart pins. The carrier search sees neither, so without these a tenant's running image could be
// deleted and its next pod start could not pull it.
import { STAGE } from "../../../shared/enums.ts";
import type { PinHit } from "../../../shared/pin.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";

/** Every image a tenant holds, at every stage. FAIL-CLOSED: a registration it cannot read throws,
 *  because the reaper must not build a floor that misses what that tenant holds. A held build is keyed
 *  on the image its chart's stage pins name for it; a build no chart pins any more renders nowhere. */
export async function tenantHeldPins(registrations: TenantRegistrations): Promise<PinHit[]> {
  const hits: PinHit[] = [];
  for (const stage of STAGE) {
    const { pointers, skipped } = await registrations.listTenantPointers(stage);
    if (skipped.length > 0) {
      throw new Error(`the tenant registrations at ${stage} cannot all be read (${skipped.map((s) => `${s.guid}: ${s.reason}`).join("; ")}) — what those tenants hold cannot be kept`);
    }
    for (const { guid } of pointers) {
      const read = await registrations.readTenant(stage, guid);
      if (!read) throw new Error(`tenant ${guid} is listed at ${stage} and its registration cannot be read — what it holds cannot be kept`);
      const { entry } = read;
      for (const member of entry.members) {
        const held = entry.approvedTags[member.name] ?? {};
        for (const source of member.sources) {
          for (const build of await registrations.listPinnedBuilds(stage, source.chart)) {
            const tag = held[build.name];
            if (tag) hits.push({ carrier: `tenant ${guid} at ${stage}: ${member.name}/${build.name}`, pin: { name: build.name, image: build.image, tag } });
          }
        }
      }
      if (entry.appsImage && entry.appsImageTag) {
        hits.push({ carrier: `tenant ${guid} at ${stage}: apps bundle`, pin: { name: entry.appsImage, image: entry.appsImage, tag: entry.appsImageTag } });
      }
    }
  }
  return hits;
}
