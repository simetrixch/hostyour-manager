import { describe, it, expect } from "vitest";
import { classifyImageTag, planRetention, type RepoTag } from "./registry-retention.ts";

// A well-formed release IMAGE tag: <x.y.z>-<channel>-<ts14>-<sha7>, as the release pipeline pushes it.
const img = (version: string, channel: "alpha" | "beta" | "stable", ts14: string, sha7 = "abc1234"): string =>
  `${version}-${channel}-${ts14}-${sha7}`;

const tags = (list: string[]): RepoTag[] => list.map((tag) => ({ tag }));

describe("classifyImageTag", () => {
  it("classifies a stable image tag as stable and recovers its ts14", () => {
    expect(classifyImageTag(img("0.6.0", "stable", "20260719120000"))).toEqual({ klass: "stable", ts14: "20260719120000" });
  });

  it("classifies alpha AND beta into the non-stable pot (both carry ts14)", () => {
    expect(classifyImageTag(img("0.6.0", "alpha", "20260718150000"))).toEqual({ klass: "non-stable", ts14: "20260718150000" });
    expect(classifyImageTag(img("1.2.0", "beta", "20260718150233"))).toEqual({ klass: "non-stable", ts14: "20260718150233" });
  });

  it("classifies a legacy / plain-SHA tag (no release grammar) as non-stable with no ts14", () => {
    expect(classifyImageTag("abc1234")).toEqual({ klass: "non-stable" }); // bare 7-hex sha
    expect(classifyImageTag("main-abc1234")).toEqual({ klass: "non-stable" }); // branch-sha style
    expect(classifyImageTag("latest")).toEqual({ klass: "non-stable" });
  });

  it("does not mis-strip a BARE release tag whose final segment is the 14-digit ts14", () => {
    // No -<sha7> suffix; the ts14 must not be confused for a sha7. Still a valid stable release.
    expect(classifyImageTag("0.6.0-stable-20260719120000")).toEqual({ klass: "stable", ts14: "20260719120000" });
  });
});

describe("planRetention — pots + count trim", () => {
  it("keeps only the newest 10 stable — the 11th (oldest) falls out", () => {
    // 11 stable releases, ts14 ascending; nothing referenced.
    const list = Array.from({ length: 11 }, (_, i) => img("0.1.0", "stable", `2026070100${String(i).padStart(4, "0")}`));
    const oldest = list[0]!; // smallest ts14
    const { keep, delete: del } = planRetention({ repoTags: tags(list), referenced: new Set() });
    expect(keep).toHaveLength(10);
    expect(del).toEqual([oldest]);
    expect(keep).not.toContain(oldest);
  });

  it("alpha + beta share ONE non-stable pot of 10 (11 combined -> oldest deleted)", () => {
    // 6 alpha + 5 beta = 11 non-stable, interleaved ts14 so the oldest overall is a known alpha.
    const alphas = Array.from({ length: 6 }, (_, i) => img("0.1.0", "alpha", `2026060100${String(i * 2).padStart(4, "0")}`));
    const betas = Array.from({ length: 5 }, (_, i) => img("0.1.0", "beta", `2026060100${String(i * 2 + 1).padStart(4, "0")}`));
    const list = [...alphas, ...betas];
    const oldest = alphas[0]!; // ts14 ...0000, the smallest
    const { keep, delete: del } = planRetention({ repoTags: tags(list), referenced: new Set() });
    expect(keep).toHaveLength(10); // ONE shared pot, not 10 alpha + 10 beta
    expect(del).toEqual([oldest]);
  });

  it("keeps stable and non-stable INDEPENDENTLY (10 + 10) — a full repo of both trims neither", () => {
    const stables = Array.from({ length: 10 }, (_, i) => img("0.2.0", "stable", `2026070100${String(i).padStart(4, "0")}`));
    const betas = Array.from({ length: 10 }, (_, i) => img("0.2.0", "beta", `2026060100${String(i).padStart(4, "0")}`));
    const { delete: del } = planRetention({ repoTags: tags([...stables, ...betas]), referenced: new Set() });
    expect(del).toEqual([]);
  });

  it("empty repoTags -> empty keep AND empty delete", () => {
    expect(planRetention({ repoTags: [], referenced: new Set() })).toEqual({ keep: [], delete: [] });
  });
});

describe("planRetention — the referenced safety floor (the rule that protects deployments)", () => {
  it("a REFERENCED tag that is the 20th-oldest SURVIVES — age never beats the floor", () => {
    // 20 stable releases; without the floor the 11 oldest would all be delete candidates.
    const list = Array.from({ length: 20 }, (_, i) => img("0.3.0", "stable", `2026070100${String(i).padStart(4, "0")}`));
    const veryOld = list[0]!; // the single OLDEST — would be deleted by the count trim
    const { keep, delete: del } = planRetention({ repoTags: tags(list), referenced: new Set([veryOld]) });
    expect(keep).toContain(veryOld); // survived purely because it is referenced
    expect(del).not.toContain(veryOld);
    // Everything else beyond the newest 10 that ISN'T referenced still ages out.
    expect(del.length).toBe(9); // 20 total - 10 kept-by-count - 1 kept-by-reference = 9
  });

  it("a referenced tag NOT present in repoTags causes no error and no phantom keep", () => {
    const list = [img("0.4.0", "stable", "20260701000000")];
    const { keep, delete: del } = planRetention({ repoTags: tags(list), referenced: new Set(["9.9.9-stable-20260101000000-0000000"]) });
    expect(keep).toEqual(list); // only the real tag, kept by count
    expect(del).toEqual([]);
  });

  it("a referenced tag is NEVER in delete even when it is off-grammar legacy and ancient", () => {
    // 12 legacy non-stable tags (no ts14) + one referenced legacy tag. The referenced one must survive
    // no matter where the deterministic legacy order places it.
    const legacy = Array.from({ length: 12 }, (_, i) => `legacy-tag-${String(i).padStart(2, "0")}`);
    const referenced = legacy[3]!;
    const { keep, delete: del } = planRetention({ repoTags: tags(legacy), referenced: new Set([referenced]) });
    expect(keep).toContain(referenced);
    expect(del).not.toContain(referenced);
  });
});

describe("planRetention — chronological tiebreak (ts14 vs push-time)", () => {
  it("orders the non-stable pot by ts14 AND by pushedAt on the same axis", () => {
    // Two alpha releases (ts14) plus two legacy tags whose only time is pushedAt. keepNonStable=2 so
    // exactly the two NEWEST across BOTH time sources survive.
    const newAlpha = img("0.5.0", "alpha", "20260720000000"); // newest overall (ts14)
    const oldAlpha = img("0.5.0", "alpha", "20260101000000"); // oldest overall (ts14)
    const repoTags: RepoTag[] = [
      { tag: newAlpha },
      { tag: oldAlpha },
      { tag: "legacy-new", pushedAt: "2026-07-19T00:00:00Z" }, // 2nd newest (push time)
      { tag: "legacy-old", pushedAt: "2026-02-01T00:00:00Z" }, // 3rd newest (push time)
    ];
    const { keep, delete: del } = planRetention({ repoTags, referenced: new Set(), keepNonStable: 2 });
    expect(new Set(keep)).toEqual(new Set([newAlpha, "legacy-new"]));
    expect(new Set(del)).toEqual(new Set([oldAlpha, "legacy-old"]));
  });

  it("a tag with a time sorts ahead of a tag with no time at all", () => {
    const timed = img("0.6.0", "beta", "20260101000000");
    const repoTags: RepoTag[] = [{ tag: "legacy-untimed" }, { tag: timed }];
    const { keep } = planRetention({ repoTags, referenced: new Set(), keepNonStable: 1 });
    expect(keep).toEqual([timed]); // the timed tag wins the single non-stable slot
  });
});
