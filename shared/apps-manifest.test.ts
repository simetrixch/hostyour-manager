import { describe, it, expect } from "vitest";
import { AppsManifestSchema, parseAppsManifest } from "./apps-manifest.ts";

const GOOD = `apps:
  - name: erp
    title: ERP
    description: Orders, stock and accounting.
    selections:
      seedReference: { title: "Reference data (roles, navigation)", default: true }
      seedDemo: { title: Demo data (showcase records) }
    databases: [core, logs, audits, auth, master]
  - name: web
    title: Website
`;

describe("parseAppsManifest", () => {
  it("parses the shape: name, title, description, selections{title, default}, databases", () => {
    const m = parseAppsManifest(GOOD);
    expect(m.apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(m.apps[0]).toEqual({
      name: "erp", title: "ERP", description: "Orders, stock and accounting.",
      selections: { seedReference: { title: "Reference data (roles, navigation)", default: true }, seedDemo: { title: "Demo data (showcase records)", default: false } },
      databases: ["core", "logs", "audits", "auth", "master"],
    });
    // Description and selections default; databases stays absent (the chart's own files decide).
    expect(m.apps[1]).toEqual({ name: "web", title: "Website", description: "", selections: {} });
  });

  it("refuses YAML that does not parse, naming the file", () => {
    expect(() => parseAppsManifest("apps: [\n  - {")).toThrow(/apps\.yaml is not parseable YAML/);
  });

  it("refuses a name outside the app grammar, a selection without a title, and a selection name that is not one camelCase word", () => {
    expect(() => parseAppsManifest("apps:\n  - name: Erp\n    title: ERP\n")).toThrow(/apps\.0\.name/);
    expect(() => parseAppsManifest("apps:\n  - name: erp\n    title: ERP\n    selections:\n      seedDemo: { default: true }\n")).toThrow(/apps\.0\.selections\.seedDemo\.title/);
    expect(() => parseAppsManifest("apps:\n  - name: erp\n    title: ERP\n    selections:\n      seed-demo: { title: Demo }\n")).toThrow(/apps\.0\.selections\.seed-demo/);
  });

  it("refuses two entries of one name — the name is the folder and the member", () => {
    expect(() => parseAppsManifest("apps:\n  - { name: erp, title: A }\n  - { name: erp, title: B }\n")).toThrow(/two entries are both named "erp"/);
  });

  it("refuses an entry without a title and an empty databases list, and a document that is not apps[]", () => {
    expect(() => parseAppsManifest("apps:\n  - name: erp\n")).toThrow(/apps\.0\.title/);
    expect(() => parseAppsManifest("apps:\n  - { name: erp, title: ERP, databases: [] }\n")).toThrow(/apps\.0\.databases/);
    expect(AppsManifestSchema.safeParse({ apps: "erp" }).success).toBe(false);
    expect(() => parseAppsManifest("erp: true\n")).toThrow(/does not match the apps manifest shape/);
  });
});
