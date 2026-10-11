import { and, eq } from "drizzle-orm";
import { parseDocument } from "yaml";
import type { Db } from "../../db/client.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import { findDnsWrite, listDnsWrites, recordDnsWrite, forgetDnsWrite, type DnsWrite } from "../../db/dns-writes.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { readOnlyPlatformRepo, type PlatformRepo } from "../../adapters/git/port.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { consumerUnitHost, tenantOwnHosts, tenantZone, tenantMemberUrl } from "#unit/shared/unit-host.ts";
import { STAGE } from "../../../shared/enums.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { applyDomainChanges, domainChanges, moveDomain, movePublicAddress } from "../../../shared/domain-move.ts";
import { memberPathOf } from "../../../shared/tenant.ts";
import { InstallationDomainSnapshotSchema, type InstallationDomainSnapshot } from "../../../shared/installation-domain.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { TenantSpec } from "../../../shared/consumer.ts";
import { refuseWithoutKey } from "./tenant-sender-domain-issuer.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";

export interface InstallationDomainPorts {
  platformRepo?: PlatformRepo;
  dns?: DnsProvider;
  consumers?: Registrations;
  tenantRegistrations?: TenantRegistrations;
  /** The kept keys and the product's tenant spec: a stage with a sender domain needs both for its issuer
   *  to move with the installation. */
  store?: Pick<CredentialStore, "list">;
  readTenantSpec?: (signal?: AbortSignal) => Promise<TenantSpec | null>;
}

export type ConfiguredInstallationDomainPorts = InstallationDomainPorts & {
  platformRepo: PlatformRepo;
  dns: DnsProvider;
  consumers: Registrations;
  tenantRegistrations: TenantRegistrations;
};

export function installationDomainPorts(ports: InstallationDomainPorts): ConfiguredInstallationDomainPorts {
  if (!ports.platformRepo || !ports.dns || !ports.consumers || !ports.tenantRegistrations)
    throw errNotConfigured("installation domain plans require the existing Cloud/Deploy books and DNS provider");
  return ports as ConfiguredInstallationDomainPorts;
}

function cookieOverrides(root: unknown, from: string, to: string): { path: string[]; before: string; after: string }[] {
  const found: { path: string[]; before: string; after: string }[] = [];
  const walk = (value: unknown, path: string[], envName = ""): void => {
    if (typeof value === "string" && (/cookie_?domain/i.test(path.at(-1) ?? "") || (path.at(-1) === "value" && /cookie_?domain/i.test(envName)))) {
      const after = value ? `${value.startsWith(".") ? "." : ""}${moveDomain(value.replace(/^\./, ""), from, to)}` : "";
      found.push({ path, before: value, after });
    } else if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>, name = typeof object.name === "string" ? object.name : envName;
      for (const key of Object.keys(object).sort()) walk(object[key], [...path, key], name);
    }
  };
  walk(root, ["members"]);
  return found;
}

/** Census from both registration authorities, including units with no Manager inventory row. */
export async function readInstallationDomain(db: Db, optional: InstallationDomainPorts, fromDomain: string, toDomain: string, signal?: AbortSignal): Promise<InstallationDomainSnapshot> {
  const configured = installationDomainPorts(optional);
  const ports = { ...configured, platformRepo: readOnlyPlatformRepo(configured.platformRepo), consumers: configured.consumers.readOnlyView(), tenantRegistrations: configured.tenantRegistrations.readOnlyView() };
  if (fromDomain === toDomain || fromDomain.endsWith(`.${toDomain}`) || toDomain.endsWith(`.${fromDomain}`)) throw errValidation("the source and target must be different, disjoint domains");
  const snapshot: InstallationDomainSnapshot = {
    fromDomain, toDomain, booksBranch: ports.platformRepo.booksBranch, clusters: [], records: [], registrations: [], tenants: [], retainedBooks: [], blockers: [],
    coverage: { clusters: 0, consumers: 0, tenants: 0, stages: [...STAGE], persistedStores: "Not moved by this run: the census of stored values is hostyour-manager#392", sessions: "Not carried over: everyone signs in once on the new hosts", cookieDomains: "Derived from tenant own-domain/zone routing; product overrides are reported, not silently changed" },
  };
  const rows = db.select().from(clusters).where(eq(clusters.status, "active")).all();
  await ports.platformRepo.withBranch(ports.platformRepo.booksBranch, async books => {
    for (const row of rows) {
      if (moveDomain(row.domain, fromDomain, toDomain) === row.domain && moveDomain(row.domain, toDomain, fromDomain) === row.domain) continue;
      const mapPath = clusterMapPath(row.domain), raw = await books.readFile(mapPath);
      if (raw === null) throw errValidation(`the books carry no ${mapPath}`);
      const map = parseDocument(raw); if (map.errors.length) throw errValidation(`${mapPath} cannot be read`);
      const apex = map.getIn(["global", "unitApex"]);
      if (typeof apex !== "string" || map.getIn(["global", "domain"]) !== row.domain || map.getIn(["global", "clusterName"]) !== row.name) throw errValidation(`${mapPath} disagrees with cluster inventory`);
      // The units move ahead of the machines: the new records point at the machine where it stands
      // now, and the machine's own rename repoints them with every other unit record.
      const fromFqdn = moveDomain(row.domain, toDomain, fromDomain), toFqdn = row.domain;
      const apexAfter = moveDomain(apex, fromDomain, toDomain);
      if (apexAfter === apex) throw errValidation(`${mapPath} does not hold an unmoved unit apex under ${fromDomain}`);
      snapshot.clusters.push({ id: row.id, serverId: row.serverId, name: row.name, fromFqdn, toFqdn, mapPath, apexBefore: apex, apexAfter });
    }
  });
  if (!snapshot.clusters.length) throw errValidation("no active cluster has an unmoved unit apex in the source domain");
  snapshot.coverage.clusters = snapshot.clusters.length;
  for (const name of await ports.consumers.listUnitNames()) for (const stage of await ports.consumers.readUnitStages(name)) {
    const read = await ports.consumers.readRegistration(stage, name);
    if (!read?.entry.cluster || !snapshot.clusters.some(c => c.name === read.entry.cluster)) throw errValidation(`consumer ${name}/${stage} is on an uncovered cluster`);
  }
  const book = listDnsWrites(db), usedBooks = new Set<string>(), recordKeys = new Set<string>();
  const key = (name: string, type: string): string => `${type} ${name}`;
  const addRecord = async (name: string, type: "CNAME" | "TXT", before: string, after: string, owner: DnsWrite["owner"]): Promise<void> => {
    if (type === "TXT") {
      const issuer = /^https?:\/\//.test(before) ? new URL(before) : null;
      if (!issuer || issuer.username || issuer.password || issuer.search || issuer.hash || movePublicAddress(before, fromDomain, toDomain) !== after) throw errValidation(`${name}: identity-provider mark is not a safe issuer URL`);
      moveDomain(issuer.hostname, fromDomain, toDomain);
    }
    const old = await ports.dns.listRecordContents({ name, type, ...(signal ? { signal } : {}) });
    // The preceding machine phase may already have repointed the OLD unit name to the new machine.
    // Journal the value that actually stands; a rollback must preserve that completed phase.
    if (!old.includes(before) && old.includes(after)) before = after;
    const targetName = type === "TXT" ? name.slice(0, name.indexOf(".") + 1) + moveDomain(name.slice(name.indexOf(".") + 1), fromDomain, toDomain) : moveDomain(name, fromDomain, toDomain);
    if (recordKeys.has(key(targetName, type))) {
      const existing = snapshot.records.find(r => r.targetName === targetName && r.type === type)!;
      if (existing.owner.kind === owner.kind && existing.owner.name === owner.name && existing.owner.stage === owner.stage && existing.before === before && existing.after === after) return;
      throw errValidation(`${targetName} has more than one unit owner`);
    }
    recordKeys.add(key(targetName, type));
    const sourceBook = findDnsWrite(db, { name, type }), targetBook = findDnsWrite(db, { name: targetName, type });
    const ours = (w: DnsWrite): boolean => w.owner.kind === owner.kind && w.owner.name === owner.name && w.owner.stage === owner.stage;
    if (sourceBook && (!ours(sourceBook) || sourceBook.content !== before)) throw errValidation(`${name}'s book entry disagrees with its registration`);
    if (targetBook && (!ours(targetBook) || (targetBook.content !== after && !(targetName === name && targetBook.content === before)))) throw errValidation(`${targetName}'s book entry belongs to another value or owner`);
    if (!old.includes(before)) snapshot.blockers.push(`${type} ${name}: the recorded source value is not present at the provider`);
    const next = await ports.dns.listRecordContents({ name: targetName, type, ...(signal ? { signal } : {}) });
    if (type === "CNAME") {
      if (next.some(v => v !== after && !(targetName === name && v === before)) || next.length > 1) snapshot.blockers.push(`${targetName}: target CNAME is occupied`);
      // A typed update of an existing owned CNAME preserves an apex's coexisting TXT.
      const ownedRepoint = targetName === name && sourceBook && old.length === 1 && old[0] === before;
      for (const other of ["A", "AAAA", "TXT"] as const) if (!(other === "TXT" && ownedRepoint) && (await ports.dns.listRecordContents({ name: targetName, type: other, ...(signal ? { signal } : {}) })).length) snapshot.blockers.push(`${targetName}: target has a ${other} record; no takeover is permitted`);
    }
    if (sourceBook) usedBooks.add(key(name, type));
    snapshot.records.push({ name, targetName, type, before, after, owner, targetHadValue: next.includes(after), sourceBook: sourceBook ? { ...sourceBook, type } : null, targetBook: targetBook ? { ...targetBook, type } : null });
  };
  for (const stage of STAGE) {
    for (const cluster of snapshot.clusters) {
      const scan = await ports.consumers.listConsumerRegistrations(cluster.name, stage);
      if (scan.skipped.length) throw errValidation(`consumer ${stage} census skipped ${scan.skipped.length} registrations`);
      for (const { name, entry } of scan.registrations) {
        snapshot.coverage.consumers++;
        const owner = { kind: "consumer", name, stage };
        await addRecord(consumerUnitHost(entry.host, stage, cluster.apexBefore), "CNAME", cluster.fromFqdn, cluster.toFqdn, owner);
        const changes = domainChanges(entry, fromDomain, toDomain, ["fqdn"]);
        snapshot.registrations.push({ kind: "consumer", name, stage, changes });
        if (entry.fqdn) {
          const target = consumerUnitHost(entry.host, stage, cluster.apexBefore);
          await addRecord(entry.fqdn, "CNAME", target, moveDomain(target, fromDomain, toDomain), owner);
        }
      }
    }
    const scan = await ports.tenantRegistrations.listTenantPointers(stage);
    if (scan.skipped.length) throw errValidation(`tenant ${stage} census skipped ${scan.skipped.length} registrations`);
    for (const pointer of scan.pointers) {
      const cluster = snapshot.clusters.find(c => c.name === pointer.cluster);
      if (!cluster) throw errValidation(`tenant ${pointer.guid}/${stage} is on an uncovered cluster`);
      const read = await ports.tenantRegistrations.readTenant(stage, pointer.guid);
      if (!read) throw errValidation(`tenant ${pointer.guid}/${stage} disappeared while planning`);
      const entry = read.entry, owner = { kind: "tenant", name: pointer.guid, stage };
      const row = db.select().from(tenants).where(and(eq(tenants.guid, pointer.guid), eq(tenants.stage, stage))).get();
      if (row && (row.clusterId !== cluster.id || row.subdomain !== entry.subdomain || row.ownDomain !== entry.ownDomain || JSON.stringify(row.ownDomainRedirects) !== JSON.stringify(entry.ownDomainRedirects))) throw errValidation(`tenant ${pointer.guid}/${stage} inventory disagrees with its registration`);
      if (row && row.identityProvider !== entry.identityProvider) throw errValidation(`tenant ${pointer.guid}/${stage} identity-provider inventory disagrees with its registration`);
      const identityProviderPath = memberPathOf(entry, entry.identityProvider);
      const changes = domainChanges(entry, fromDomain, toDomain, ["ownDomain", "ownDomainRedirects", "apps", "members"], path => snapshot.blockers.push(`tenant ${pointer.guid}/${stage}: domain field ${path.join(".")} cannot be safely journaled; its private address must be resolved before cutover`));
      snapshot.registrations.push({ kind: "tenant", name: pointer.guid, stage, changes });
      const ownDomainAfter = movePublicAddress(entry.ownDomain, fromDomain, toDomain), redirectsAfter = entry.ownDomainRedirects.map(h => moveDomain(h, fromDomain, toDomain));
      snapshot.tenants.push({ id: row?.id ?? null, guid: pointer.guid, stage,
        issuerBefore: tenantMemberUrl(identityProviderPath, stage, entry.subdomain, cluster.apexBefore, entry.ownDomain),
        issuerAfter: tenantMemberUrl(identityProviderPath, stage, entry.subdomain, cluster.apexAfter, ownDomainAfter),
        cookieBefore: entry.ownDomain ? "" : tenantZone(entry.subdomain, stage, cluster.apexBefore),
        cookieAfter: ownDomainAfter ? "" : tenantZone(entry.subdomain, stage, cluster.apexAfter),
        cookieOverrides: cookieOverrides(entry.members, fromDomain, toDomain),
        ownDomainBefore: entry.ownDomain, ownDomainAfter, redirectsBefore: entry.ownDomainRedirects, redirectsAfter,
        senderDomain: entry.senderDomain, zoneBefore: tenantZone(entry.subdomain, stage, cluster.apexBefore),
        zoneAfter: tenantZone(entry.subdomain, stage, cluster.apexAfter), clusterId: cluster.id, members: entry.members.map((m) => m.name) });
      snapshot.coverage.tenants++;
      await addRecord(tenantZone(entry.subdomain, stage, cluster.apexBefore), "CNAME", cluster.fromFqdn, cluster.toFqdn, owner);
      const marks = book.filter(w => w.type === "TXT" && w.name.startsWith("_") && w.owner.kind === "tenant" && w.owner.name === pointer.guid && w.owner.stage === stage);
      if (!marks.length) snapshot.blockers.push(`tenant ${pointer.guid}/${stage}: no booked identity-provider mark`);
      for (const mark of marks) await addRecord(mark.name, "TXT", mark.content, movePublicAddress(mark.content, fromDomain, toDomain), owner);
      for (const host of new Set(tenantOwnHosts(entry.ownDomain, entry.ownDomainRedirects, entry.ownDomainAliases))) {
        // External web hosts retain their record names; only an installation-zone target is repointed.
        const target = tenantZone(entry.subdomain, stage, cluster.apexBefore);
        await addRecord(host, "CNAME", target, moveDomain(target, fromDomain, toDomain), owner);
      }
    }
  }
  for (const row of db.select().from(tenants).where(eq(tenants.status, "active")).all()) {
    if (!snapshot.tenants.some(t => t.guid === row.guid && t.stage === row.stage)) snapshot.blockers.push(`tenant ${row.guid}/${row.stage}: active inventory has no covered registration`);
  }
  // A stage with a sender domain of its own takes its issuer along; the plan refuses the move where it could not.
  const senders = snapshot.tenants.filter((t) => t.senderDomain);
  if (senders.length && (!ports.store || !ports.readTenantSpec)) {
    snapshot.blockers.push(`${senders.length} tenant stage(s) send from a domain of their own, and this Manager cannot read the product's tenant spec or its kept keys to move their issuers`);
  } else if (senders.length) {
    const route = (await ports.readTenantSpec!(signal))?.senderDomainIssuers;
    if (route) for (const t of senders) {
      const refused = await refuseWithoutKey(ports.store!, route, t.stage);
      if (refused) snapshot.blockers.push(`tenant ${t.guid}/${t.stage}: ${refused}`);
    }
  }
  for (const w of book) if (!usedBooks.has(key(w.name, w.type))) {
    snapshot.retainedBooks.push({ name: w.name, type: w.type, reason: "Not an active unit record in this plan; retained unchanged" });
    if (["consumer", "tenant"].includes(w.owner.kind) && (w.name === fromDomain || w.name.endsWith(`.${fromDomain}`))) snapshot.blockers.push(`${w.type} ${w.name}: booked unit record has no active registration in the census`);
  }
  snapshot.blockers = [...new Set(snapshot.blockers)].sort();
  return InstallationDomainSnapshotSchema.parse(snapshot);
}

/** Forward unit phase, and its inverse. The old records are never deleted by either direction. */
export async function applyInstallationDomain(ctx: StepCtx, optional: InstallationDomainPorts, snapshot: InstallationDomainSnapshot, reverse: boolean, sourceRunId: string, readOnly = false): Promise<void> {
  const ports = installationDomainPorts(optional);
  const writeMaps = async (validateOnly = false): Promise<void> => {
    await (validateOnly ? readOnlyPlatformRepo(ports.platformRepo) : ports.platformRepo).withBranch(snapshot.booksBranch, async books => {
      const write: { path: string; content: string }[] = [];
      for (const cluster of snapshot.clusters) {
        const raw = await books.readFile(cluster.mapPath);
        if (raw === null) throw errValidation(`${cluster.mapPath} disappeared; no map is overwritten`);
        const map = parseDocument(raw);
        const before = reverse ? cluster.apexAfter : cluster.apexBefore, after = reverse ? cluster.apexBefore : cluster.apexAfter;
        const standing = map.getIn(["global", "unitApex"]);
        if (map.errors.length || (standing !== before && standing !== after) || map.getIn(["global", "clusterName"]) !== cluster.name || map.getIn(["global", "domain"]) !== cluster.toFqdn || ctx.db.select().from(clusters).where(eq(clusters.id, cluster.id)).get()?.domain !== cluster.toFqdn) throw errValidation(`${cluster.mapPath} changed since planning; no map is overwritten`);
        if (standing === after) continue;
        map.setIn(["global", "unitApex"], after);
        // The old apex beside the new one, in the same commit: the appsets render a redirect from each
        // unit's old host to its new one while it stands. The way back removes it with the move.
        if (reverse) map.deleteIn(["global", "previousUnitApex"]);
        else map.setIn(["global", "previousUnitApex"], before);
        write.push({ path: cluster.mapPath, content: map.toString() });
      }
      if (write.length && !validateOnly) {
        const result = await books.commit({ message: `installation-domain: ${reverse ? "restore" : "move"} unit apex [${ctx.runId}]`, write });
        ctx.log("meta", `unit apex maps ${reverse ? "restored" : "moved"} (${result.commit})`);
      }
    });
  };
  const writeRegistrations = async (validateOnly = false): Promise<void> => {
    for (const registration of snapshot.registrations) {
      const writer = registration.kind === "tenant" ? ports.tenantRegistrations : ports.consumers;
      if (validateOnly) {
        const current = registration.kind === "tenant" ? await ports.tenantRegistrations.readOnlyView().readTenant(registration.stage, registration.name) : await ports.consumers.readOnlyView().readRegistration(registration.stage, registration.name);
        if (!current) throw errValidation(`registration ${registration.name}/${registration.stage} disappeared`);
        applyDomainChanges(current.entry, registration.changes, reverse);
      } else await writer.compareDomainFields(registration.stage, registration.name, registration.changes, reverse, ctx.runId);
    }
    for (const tenant of snapshot.tenants) if (tenant.id !== null) {
      const row = ctx.db.select().from(tenants).where(eq(tenants.id, tenant.id)).get();
      const before = reverse ? tenant.ownDomainAfter : tenant.ownDomainBefore, after = reverse ? tenant.ownDomainBefore : tenant.ownDomainAfter;
      const redirectsBefore = reverse ? tenant.redirectsAfter : tenant.redirectsBefore, redirectsAfter = reverse ? tenant.redirectsBefore : tenant.redirectsAfter;
      if (!row || (row.ownDomain !== before && row.ownDomain !== after) || ![JSON.stringify(redirectsBefore), JSON.stringify(redirectsAfter)].includes(JSON.stringify(row.ownDomainRedirects))) throw errValidation(`tenant ${tenant.guid}/${tenant.stage} domain inventory changed since planning`);
      if (!validateOnly && (row.ownDomain !== after || JSON.stringify(row.ownDomainRedirects) !== JSON.stringify(redirectsAfter))) ctx.db.update(tenants).set({ ownDomain: after, ownDomainRedirects: redirectsAfter }).where(eq(tenants.id, tenant.id)).run();
    }
  };
  const writeRecords = async (validateOnly = false): Promise<void> => {
    for (const record of reverse ? [...snapshot.records].reverse() : snapshot.records) {
      const current = await ports.dns.listRecordContents({ name: record.targetName, type: record.type, signal: ctx.signal });
      const currentBook = findDnsWrite(ctx.db, { name: record.targetName, type: record.type });
      if (reverse) {
        if (record.type === "CNAME" && current.some(v => v !== record.after && !(record.name === record.targetName && v === record.before))) throw errValidation(`${record.targetName}: provider value changed; rollback refuses`);
        if (currentBook && currentBook.runId !== sourceRunId && currentBook.runId !== ctx.runId) {
          if (record.targetBook && currentBook.content === record.targetBook.content && currentBook.owner.kind === record.targetBook.owner.kind && currentBook.owner.name === record.targetBook.owner.name && currentBook.owner.stage === record.targetBook.owner.stage && currentBook.runId === record.targetBook.runId) continue;
          throw errValidation(`${record.targetName}: a newer book writer owns the record; rollback refuses`);
        }
        if (record.targetName === record.name) {
          if (current.some(v => v !== record.after && v !== record.before) || current.length > 1) throw errValidation(`${record.targetName}: provider value changed; rollback refuses`);
          if (!validateOnly && current[0] !== record.before) await ports.dns.upsertRecord({ name: record.name, type: record.type, content: record.before, signal: ctx.signal });
        } else if (!record.targetHadValue && current.includes(record.after)) {
          if (!currentBook || currentBook.runId !== sourceRunId) throw errValidation(`${record.targetName}: rollback cannot prove this run owns the new record`);
          if (record.type === "CNAME" && current.some(v => v !== record.after)) throw errValidation(`${record.targetName}: provider value changed; rollback refuses`);
          if (!validateOnly) await ports.dns.deleteRecord({ name: record.targetName, type: record.type, content: record.after, signal: ctx.signal });
        }
        if (!validateOnly && record.targetBook) recordDnsWrite(ctx.db, { ...record.targetBook, owner: { kind: record.targetBook.owner.kind, name: record.targetBook.owner.name, ...(record.targetBook.owner.stage ? { stage: record.targetBook.owner.stage } : {}) } });
        else if (!validateOnly && currentBook) forgetDnsWrite(ctx.db, { name: record.targetName, type: record.type });
        continue;
      }
      if (currentBook && (currentBook.owner.kind !== record.owner.kind || currentBook.owner.name !== record.owner.name || currentBook.owner.stage !== record.owner.stage || ![record.before, record.after].includes(currentBook.content))) throw errValidation(`${record.targetName}: book ownership changed since planning`);
      if (record.type === "CNAME" && current.some(v => v !== record.after && !(record.name === record.targetName && v === record.before))) throw errValidation(`${record.targetName}: provider value changed since planning`);
      ctx.checkpoint({ record: record.targetName, intent: record.after });
      if (!current.includes(record.after)) {
        if (record.type === "TXT") await ports.dns.createRecord({ name: record.targetName, type: record.type, content: record.after, signal: ctx.signal });
        else await ports.dns.upsertRecord({ name: record.targetName, type: record.type, content: record.after, signal: ctx.signal });
      }
      recordDnsWrite(ctx.db, { name: record.targetName, type: record.type, content: record.after, act: current.includes(record.after) ? "adopted" : record.name === record.targetName ? "updated" : "inserted", owner: { kind: record.owner.kind, name: record.owner.name, ...(record.owner.stage ? { stage: record.owner.stage } : {}) }, runId: ctx.runId });
      ctx.log("meta", `${record.type} ${record.targetName} → ${record.after}; old name retained`);
    }
  };
  if (reverse) {
    // Refuse every known conflict before the first inverse write. Each writer then rechecks its CAS.
    await writeRecords(true); await writeRegistrations(true); await writeMaps(true);
    if (readOnly) return;
    await writeMaps(); await writeRegistrations(); await writeRecords();
  }
  else { await writeRecords(); await writeRegistrations(); await writeMaps(); }
}

export async function validateInstallationDomainRollback(ctx: StepCtx, ports: InstallationDomainPorts, snapshot: InstallationDomainSnapshot, sourceRunId: string): Promise<void> {
  await applyInstallationDomain(ctx, ports, snapshot, true, sourceRunId, true);
}
