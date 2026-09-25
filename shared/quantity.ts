// Arithmetic on Kubernetes quantities, for the one thing this platform has to do with them: add the
// parts of a unit's quota together. A unit's ceiling is base + postgresql + mongodb x members, and
// those parts are written the way Kubernetes writes them — "400m", "1Gi", "512Mi" — so they cannot be
// summed as numbers without first agreeing what unit they are in.
//
// TWO SCALES, and they are not interchangeable. CPU is decimal and counted in millicores: "1" is 1000m.
// Memory is counted in bytes and carries either binary suffixes (Ki, Mi, Gi — powers of 1024) or
// decimal ones (k, M, G — powers of 1000); "1Gi" and "1G" are different amounts, and treating them as
// the same is how a quota ends up 7% smaller than the operator meant.
//
// The output is deliberately the LARGEST suffix that divides the sum exactly, so a sum of round inputs
// reads round: 1Gi + 1Gi is "2Gi", not "2147483648". Where it does not divide (1Gi + 512Mi) the next
// suffix down is used and the value stays exact — never rounded, because a quota an operator cannot
// recognise in the file is a quota nobody checks.

const CPU_SUFFIX: Record<string, number> = { m: 1, "": 1000 };

/** Binary first: a plain `M` is 10^6 and `Mi` is 2^20, and the longer suffix must match first. */
const MEM_SUFFIX: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  k: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6,
  "": 1,
};

const QUANTITY = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/;

function parse(value: string, table: Record<string, number>, kind: string): number {
  const m = QUANTITY.exec(value.trim());
  const factor = m ? table[m[2] ?? ""] : undefined;
  if (!m || factor === undefined) {
    throw new Error(`not a ${kind} quantity: "${value}" (want a number with an optional unit, e.g. ${kind === "cpu" ? '"500m" or "2"' : '"512Mi" or "2Gi"'})`);
  }
  return Number(m[1]) * factor;
}

/** Format an exact amount back, using the largest suffix of the family that divides it. */
function format(amount: number, order: [string, number][]): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`cannot format quantity ${amount}`);
  // Zero divides by every factor, so without this it would come out as the LARGEST suffix ("0Ei") —
  // technically the same amount and unreadable as the nothing it is.
  if (amount === 0) return "0";
  for (const [suffix, factor] of order) {
    if (amount % factor === 0) return `${amount / factor}${suffix}`;
  }
  return String(amount);
}

const CPU_ORDER: [string, number][] = [["", 1000], ["m", 1]];
/** Binary only on the way out. A sum of binary inputs is a binary amount, and switching families in
 *  the output would make "1Gi + 1Gi" read as something other than "2Gi". */
const MEM_ORDER: [string, number][] = [["Ei", 1024 ** 6], ["Pi", 1024 ** 5], ["Ti", 1024 ** 4], ["Gi", 1024 ** 3], ["Mi", 1024 ** 2], ["Ki", 1024], ["", 1]];

/** Sum CPU quantities. "400m" + "50m" -> "450m"; "500m" + "500m" -> "1". */
export function addCpu(...values: string[]): string {
  return format(values.reduce((sum, v) => sum + parse(v, CPU_SUFFIX, "cpu"), 0), CPU_ORDER);
}

/** Sum memory quantities. "1Gi" + "512Mi" -> "1536Mi" (exact, and recognisably the two parts). */
export function addMemory(...values: string[]): string {
  return format(values.reduce((sum, v) => sum + parse(v, MEM_SUFFIX, "memory"), 0), MEM_ORDER);
}

/** Multiply a CPU quantity by a whole count — a MongoDB replica set is one member's figure times its
 *  member count, and doing that by repeated addition would hide what the number means. */
export function timesCpu(value: string, n: number): string {
  return format(parse(value, CPU_SUFFIX, "cpu") * n, CPU_ORDER);
}

export function timesMemory(value: string, n: number): string {
  return format(parse(value, MEM_SUFFIX, "memory") * n, MEM_ORDER);
}
