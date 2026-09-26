import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// THE TWO PIN WRITERS OF THE RELEASE KIT, run on a values tree: the python pinner release.sh writes
// out of its PIN heredoc, and Write-StagePin of release.ps1. Each is cut out of the asset as it
// stands, so what runs here is what a release runs. They write a build's tag and, beside it, what
// the build's pinValues name (hostyour-cloud#244), and they write the same bytes.

const ASSETS = fileURLToPath(new URL("./assets/", import.meta.url));
const SH = readFileSync(join(ASSETS, "release.sh"), "utf8");
const PS1 = readFileSync(join(ASSETS, "release.ps1"), "utf8");
const OWN_MANIFEST = fileURLToPath(new URL("../../../../deploy/platform.yaml", import.meta.url));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mgr-pin-"));
  dirs.push(dir);
  return dir;
}

/** The text between two markers of an asset, the markers left out. */
function between(text: string, open: string, close: string): string {
  const from = text.indexOf(open);
  const to = text.indexOf(close, from + open.length);
  if (from < 0 || to < 0) throw new Error(`the asset carries no ${JSON.stringify(open)} ... ${JSON.stringify(close)}`);
  return text.slice(from + open.length, to);
}

const scripts = tempDir();
const PINNER = join(scripts, "pin.py");
writeFileSync(PINNER, between(SH, "cat > \"$PINNER\" <<'PIN'\n", "\nPIN\n"));
const WRITER = join(scripts, "pin.ps1");
writeFileSync(WRITER, [
  "$ErrorActionPreference = 'Stop'",
  `function Write-StagePin {${between(PS1, "function Write-StagePin {", "\n}\n")}\n}`,
  "try { $out = @(Write-StagePin -Tree $args[0] -PinStage $args[1] -ImageTag $args[2] -Manifest $args[3]); [Console]::Out.Write(($out -join ' ') + \"`n\") }",
  "catch { [Console]::Out.Write($_.Exception.Message + \"`n\"); exit 3 }",
  "",
].join("\n"));

type Twin = "sh" | "ps1";
const COMMAND: Record<Twin, (args: string[]) => [string, string[]]> = {
  sh: (args) => ["python3", [PINNER, ...args]],
  ps1: (args) => ["pwsh", ["-NoProfile", "-NonInteractive", "-File", WRITER, ...args]],
};
function run(twin: Twin, args: string[]): { status: number | null; stdout: string } {
  const [file, argv] = COMMAND[twin](args);
  const r = spawnSync(file, argv, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/** Can this twin's interpreter run its pinner on an empty tree? Asked of the pinner itself. */
function runs(twin: Twin): boolean {
  const dir = tempDir();
  writeFileSync(join(dir, "platform.yaml"), "name: probe\nbuilds:\n  - name: probe\n");
  const r = run(twin, [dir, "prod", "1.0.0-stable-20260101000000-abcdef1", join(dir, "platform.yaml")]);
  return r.status === 0 && r.stdout === "\n";
}
const USABLE = { sh: runs("sh"), ps1: runs("ps1") };
const BOTH = USABLE.sh && USABLE.ps1;

const OLD = '"0.8.279-stable-20260925234902-2296bc9"';
const TAG = "1.2.3-stable-20260101000000-abcdef1";
const lines = (...l: string[]): string => [...l, ""].join("\n");
const MANIFEST = lines(
  "name: acme-unit",
  "builds:",
  "  - name: manager                # the in-cluster app",
  "    containerfile: Containerfile",
  "    # what the image activates, written beside its tag",
  "    pinValues:",
  '      plugins: "unit,consumer"',
  "  - name: dbtools",
  "    containerfile: docker/dbtools.Dockerfile",
  "services: []",
);
const VALUES = lines(
  "# PROD pins",
  "builds:",
  "  - name: manager",
  "    image: manager",
  `    tag: ${OLD}`,
  "  # the job image",
  "  - name: dbtools",
  "    image: dbtools",
  `    tag: ${OLD}`,
);

/** One pin written by one twin: the values file after it, and what the twin answered. */
function pin(twin: Twin, values: string, manifest: string): { status: number | null; stdout: string; written: string } {
  const tree = tempDir();
  const inventory = join(tree, "clusters", "inventories", "manager");
  mkdirSync(inventory, { recursive: true });
  const file = join(inventory, "values-prod.yaml");
  writeFileSync(file, values);
  const manifestFile = join(tree, "platform.yaml");
  writeFileSync(manifestFile, manifest);
  const r = run(twin, [tree, "prod", TAG, manifestFile]);
  return { ...r, written: readFileSync(file, "utf8") };
}

/** Both twins over the same input, required to answer and write the same bytes. */
function bothPin(values: string, manifest: string): { status: number | null; stdout: string; written: string } {
  const sh = pin("sh", values, manifest);
  const ps1 = pin("ps1", values, manifest);
  expect(ps1.stdout).toBe(sh.stdout);
  expect(ps1.status).toBe(sh.status);
  expect(ps1.written).toBe(sh.written);
  return sh;
}

describe.skipIf(!BOTH)("the pin writers of both release-kit twins", () => {
  if (!BOTH) {
    // eslint-disable-next-line no-console -- a skipped comparison must be loud: a silent skip reads as a pass
    console.warn(`no ${!USABLE.sh ? "python3" : "pwsh"} runs its pinner here, so the two pin writers have never been run against each other on this machine`);
  }

  it("writes a build's pinValues right after its tag where the entry carries none, and only the tag of a build without", () => {
    const r = bothPin(VALUES, MANIFEST);
    expect(r).toEqual({
      status: 0,
      stdout: "clusters/inventories/manager/values-prod.yaml\n",
      written: lines(
        "# PROD pins",
        "builds:",
        "  - name: manager",
        "    image: manager",
        `    tag: "${TAG}"`,
        '    plugins: "unit,consumer"',
        "  # the job image",
        "  - name: dbtools",
        "    image: dbtools",
        `    tag: "${TAG}"`,
      ),
    });
  });

  it("replaces the key's line where the entry already carries it, wherever it stands in the entry", () => {
    const carrying = VALUES.replace("    image: manager\n", '    image: manager\n    plugins: "unit"   # the set before\n');
    expect(bothPin(carrying, MANIFEST).written).toBe(lines(
      "# PROD pins",
      "builds:",
      "  - name: manager",
      "    image: manager",
      '    plugins: "unit,consumer"',
      `    tag: "${TAG}"`,
      "  # the job image",
      "  - name: dbtools",
      "    image: dbtools",
      `    tag: "${TAG}"`,
    ));
  });

  it("pins as it always did where no build declares pinValues: the file differs in its tags and nowhere else", () => {
    const plain = MANIFEST.replace('    # what the image activates, written beside its tag\n    pinValues:\n      plugins: "unit,consumer"\n', "");
    expect(plain).not.toContain("pinValues");
    expect(bothPin(VALUES, plain).written).toBe(VALUES.replaceAll(OLD, `"${TAG}"`));
  });

  it("refuses pinValues it cannot read, identically and before it touches a file", () => {
    const refusals: [string, string][] = [
      ['    pinValues: { plugins: "unit" }\n', 'line 6 writes the pinValues of manager on one line - write one key: "value" pair per line below it\n'],
      ["    pinValues:\n      plugins: unit\n", 'line 7 is no key: "value" pair of the pinValues of manager\n'],
      ['    pinValues:\n      tag: "x"\n', 'line 7 is no key: "value" pair of the pinValues of manager\n'],
    ];
    for (const [block, said] of refusals) {
      const r = bothPin(VALUES, MANIFEST.replace('    pinValues:\n      plugins: "unit,consumer"\n', block));
      expect(r).toEqual({ status: 3, stdout: said, written: VALUES });
    }
  });

  it("reads this repository's own manifest as a YAML parser does: the manager's entry carries what it declares", () => {
    const own = readFileSync(OWN_MANIFEST, "utf8");
    type Builds = { builds: { name: string; tag?: string; pinValues?: Record<string, string> }[] };
    const declared = (parseYaml(own) as Builds).builds.find((b) => b.name === "manager")?.pinValues;
    expect(declared).toBeDefined();
    const entry = (parseYaml(bothPin(VALUES, own).written) as Builds).builds.find((b) => b.name === "manager");
    expect(entry).toEqual({ name: "manager", image: "manager", tag: TAG, ...declared });
  });
});
