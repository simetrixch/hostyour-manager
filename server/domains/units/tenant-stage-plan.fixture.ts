import { servers, clusters } from "../../db/schema/inventory.ts";
import { FakeClusterKubeResolver, FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeObjectStore } from "../../adapters/object-store/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { fakeTenantSeeder } from "./tenant-seeder.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { db, ports, seedTenant } from "./tenant-refresh-members.fixture.ts";

// PROD stands on cls_1; TEST never may, so a stage added beside it goes to the second machine.
export function stagePorts() {
  seedTenant();
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
  const p = ports(testMembers(["erp"]));
  const machine = (domain: string) => ({ clusterReader: new FakeClusterReader({
    deployState: { domain, stage: "prod", writtenAt: "2026-10-01T00:00:00Z", generation: 1 },
  }), argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd" });
  const resolver = new FakeClusterKubeResolver(machine("s1.example"));
  resolver.set("cls_2", machine("s2.example"));
  p.resolver = resolver;
  p.seeder = fakeTenantSeeder();
  p.objectStore = new FakeObjectStore();
  p.dns = new FakeDnsProvider();
  return p;
}

export const request = { clusterId: "cls_1", stage: "prod", subdomain: "newtenant", owner: "team-acme", size: "small", apps: [] };
export const addRequest = { ...request, clusterId: "cls_2", sourceTenantId: "tnt_1" };
