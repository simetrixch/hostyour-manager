import { errValidation } from "../../kernel/errors.ts";

/** One-line 400 mapping of a zod parse failure, shared by the units' route modules (api.ts,
 *  api-live.ts). Structurally typed over the issues so no zod value/type import leaks into a thin
 *  route module. */
export function invalid(kind: string, err: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): never {
  throw errValidation(`invalid ${kind} request: ${err.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`);
}
