import { describe, it, expect } from "vitest";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import {
  readChannelStages, assertChannelReaches, CHANNEL_STAGES_PATH, CHANNEL_STAGES_BRANCH,
} from "./channel-stages.ts";
import type { ChannelStages } from "./channel-stages.ts";

// The channel ceiling has ONE table and it is not in this repo: it is global.channelStages in the
// platform repo's clusters/platform/values-common.yaml. What these tests hold down is that this module READS
// that file and states nothing of its own — a manager-side copy would be a second table, and a
// second table is a place for the two to disagree about which stages a release may reach.

const TABLE = [
  "global:",
  "  timezone: Europe/Amsterdam",
  "  channelStages:",
  "    alpha: [dev]",
  "    beta: [dev, test]",
  "    stable: [dev, test, prod]",
].join("\n") + "\n";

function repoWith(text: string | null): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  if (text !== null) repo.seed(CHANNEL_STAGES_BRANCH, CHANNEL_STAGES_PATH, text);
  return repo;
}

describe("readChannelStages", () => {
  it("serves the table off the trunk, verbatim — the copy every cluster shares", async () => {
    expect(await readChannelStages(repoWith(TABLE))).toEqual({ alpha: ["dev"], beta: ["dev", "test"], stable: ["dev", "test", "prod"] });
  });

  it("fails loud when the file carries no readable table — a ceiling nobody can read may never default open", async () => {
    await expect(readChannelStages(repoWith("global:\n  timezone: Europe/Amsterdam\n"))).rejects.toThrow(/no readable global.channelStages/);
    await expect(readChannelStages(repoWith("global:\n  channelStages:\n    alpha: dev\n"))).rejects.toThrow(/no readable global.channelStages/);
  });
});

describe("assertChannelReaches", () => {
  const table: ChannelStages = { alpha: ["dev"], beta: ["dev", "test"], stable: ["dev", "test", "prod"] };

  it("passes a channel the target's stage is inside", () => {
    expect(() => assertChannelReaches(table, "stable", "prod", "platform release 1.0.0-stable")).not.toThrow();
    expect(() => assertChannelReaches(table, "beta", "test", "platform release 1.0.0-beta")).not.toThrow();
  });

  it("refuses naming the channel, the stage AND the stages that channel does reach", () => {
    // The operator must be able to read the rule off the refusal — otherwise the answer to "why not?"
    // is a file they have to go and find.
    expect(() => assertChannelReaches(table, "alpha", "prod", "platform release 1.0.0-alpha"))
      .toThrow(/1\.0\.0-alpha.*alpha channel, which reaches dev.*marked prod/s);
  });

  it("refuses a channel the table does not mention at all — an unlisted channel reaches nothing", () => {
    expect(() => assertChannelReaches({ stable: ["prod"] }, "alpha", "dev", "x")).toThrow(/reaches no stage/);
  });
});
