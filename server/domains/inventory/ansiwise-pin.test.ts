import { describe, it, expect } from "vitest";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { readAnsiwisePin, ANSIWISE_PIN_PATH, ANSIWISE_PIN_BRANCH } from "./ansiwise-pin.ts";

// The version of the binary a machine is given has ONE source and it is not in this repo: it is
// cliTools.ansiwise.version in the platform repo's platform/versions.yaml. What these tests hold
// down is that this module READS that file and states nothing of its own — a version this process
// could supply on its own would be a second answer to "which ansiwise does this installation run",
// and the machine would end up carrying whichever of the two happened to be asked.

const VERSIONS = [
  "cliTools:",
  "  argocd:",
  '    version: "v3.4.5"',
  "  ansiwise:",
  '    version: "0.4.2"',
  "  yq:",
  '    version: "v4.53.3"',
].join("\n") + "\n";

function repoWith(text: string | null): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  if (text !== null) repo.seed(ANSIWISE_PIN_BRANCH, ANSIWISE_PIN_PATH, text);
  return repo;
}

describe("readAnsiwisePin", () => {
  it("serves the pin off the trunk, out of a file that states every other component too", async () => {
    expect(await readAnsiwisePin(repoWith(VERSIONS))).toBe("0.4.2");
  });

  it("fails loud when the file is not there at all, naming the file and the branch", async () => {
    await expect(readAnsiwisePin(repoWith(null))).rejects.toThrow(/platform\/versions\.yaml on the platform repo's master branch/);
  });

  it("fails loud when the entry is missing or carries no version — a placement may never pick one itself", async () => {
    // The file exists and states other components: exactly the shape in which a default would go
    // unnoticed, because everything around the missing entry reads fine.
    await expect(readAnsiwisePin(repoWith('cliTools:\n  yq:\n    version: "v4.53.3"\n')))
      .rejects.toThrow(/no readable cliTools\.ansiwise\.version/);
    await expect(readAnsiwisePin(repoWith("cliTools:\n  ansiwise:\n    upstream:\n      kind: github_release\n")))
      .rejects.toThrow(/no readable cliTools\.ansiwise\.version/);
    await expect(readAnsiwisePin(repoWith('cliTools:\n  ansiwise:\n    version: ""\n')))
      .rejects.toThrow(/no readable cliTools\.ansiwise\.version/);
  });
});
