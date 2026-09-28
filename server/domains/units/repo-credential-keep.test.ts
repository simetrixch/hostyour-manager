// A unit's ArgoCD repository access (repo-credential-keep.ts): a repository the owner's GitHub App
// reaches has no Secret of its own — ArgoCD reads it through the App's credential template — so a
// standing token Secret is removed; any other gets its owner's PAT written.
import { describe, it, expect } from "vitest";
import type { CredentialStore } from "../../security/store.ts";
import { FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { renderConsumerRepoCredential } from "./repo-credential.ts";
import { keepUnitRepoCredential } from "./repo-credential-keep.ts";

/** The App's one row (kind github-app) and the owner acme's repository PAT. */
const store: Pick<CredentialStore, "list" | "open"> = {
  list: async (filter) => {
    const all = [
      { id: "cred_app", kind: "github-app" as const, label: "GitHub App (acme)", fingerprint: "sha256:app", subject: { kind: "owner" as const, id: "acme" }, purpose: "repository-identity" as const, recordedAt: "2026-01-01T00:00:00.000Z" },
      { id: "cred_pat", kind: "pat" as const, label: "repository PAT (acme)", fingerprint: "sha256:pat", subject: { kind: "owner" as const, id: "acme" }, purpose: "repository-pat" as const, recordedAt: "2026-01-01T00:00:00.000Z" },
    ];
    return all.filter((c) => !filter?.kind || c.kind === filter.kind);
  },
  open: async (id) => {
    if (id === "cred_pat") return Buffer.from("github_pat_shop", "utf8");
    throw new Error(`credential ${id} is not opened for a repository Secret`);
  },
};

/** A repository Secret standing for acme/<name>: a token an earlier onboarding wrote, or a PAT. */
async function standingSecret(writer: FakeRepoCredentialWriter, name: string, value: string): Promise<void> {
  await writer.applyRepoCredential(renderConsumerRepoCredential({ consumerName: name, stage: "prod", argoNamespace: "argocd", repoURL: `https://github.com/acme/${name}`, pat: value }));
}

describe("keepUnitRepoCredential", () => {
  it("removes the token Secret of a unit the App reaches and writes none", async () => {
    const writer = new FakeRepoCredentialWriter();
    await standingSecret(writer, "post", "ghs_expired");
    const kept = await keepUnitRepoCredential({ store, repoCredential: writer }, { name: "post", stage: "prod", repoURL: "https://github.com/acme/post", credentialId: "cred_app", argoNamespace: "argocd" }, { purpose: "test" });
    expect(kept).toEqual({ identity: "github-app", removed: true });
    expect(writer.keys()).toEqual([]);
  });

  it("writes a PAT unit's Secret, and replaces it in place where it stands", async () => {
    const writer = new FakeRepoCredentialWriter();
    const unit = { name: "shop", stage: "prod" as const, repoURL: "https://github.com/acme/shop", credentialId: "cred_pat", argoNamespace: "argocd" };
    expect(await keepUnitRepoCredential({ store, repoCredential: writer }, unit, { purpose: "test" })).toEqual({ identity: "pat", created: true });
    expect(await keepUnitRepoCredential({ store, repoCredential: writer }, unit, { purpose: "test" })).toEqual({ identity: "pat", created: false });
    expect(writer.keys()).toEqual(["argocd/repo-shop-prod"]);
  });
});
