import { describe, it, expect } from "vitest";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { readAnsiwisePin, ANSIWISE_PIN_PATH, ANSIWISE_PIN_BRANCH } from "./ansiwise-pin.ts";

// The version of the binary a machine is given has ONE source and it is not in this repo: it is
// cliTools.ansiwise.version in the platform repo's clusters/platform/versions.yaml. What these tests hold
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

/** WHERE THE PLATFORM REPOSITORY REALLY CARRIES THE FILE, as a literal and never as the constant
 *  under test. Seeding the fake from ANSIWISE_PIN_PATH makes the fixture agree with the reader
 *  whatever that repository holds, which is exactly how such a path goes on naming
 *  `platform/versions.yaml` after a rename moves it under `clusters/`: green here, and a
 *  slave's engine placement dying on the machine with a message naming a file nobody had moved.
 *  Measured in the platform repository — `master:clusters/platform/versions.yaml`
 *  exists, `master:platform/versions.yaml` does not. */
const PIN_FILE_ON_THE_PLATFORM_REPO = "clusters/platform/versions.yaml";

function repoWith(text: string | null): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  if (text !== null) repo.seed(ANSIWISE_PIN_BRANCH, PIN_FILE_ON_THE_PLATFORM_REPO, text);
  return repo;
}

describe("readAnsiwisePin", () => {
  it("looks where the platform repository actually carries the file", () => {
    expect(ANSIWISE_PIN_PATH).toBe(PIN_FILE_ON_THE_PLATFORM_REPO);
  });

  it("serves the pin off the trunk, out of a file that states every other component too", async () => {
    expect(await readAnsiwisePin(repoWith(VERSIONS))).toBe("0.4.2");
  });

  it("fails loud when the file is not there at all, naming the file and the branch", async () => {
    await expect(readAnsiwisePin(repoWith(null)))
      .rejects.toThrow(/clusters\/platform\/versions\.yaml on the platform repo's master branch/);
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
