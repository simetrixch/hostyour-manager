// authoritative-ttl.ts — query the zone's authoritative server over UDP port 53
// for the TTL served for a record name, so relocation steps clear the source
// only after resolvers have ceased serving the old address.
import * as dns from "node:dns";
import * as dgram from "node:dgram";
import * as crypto from "node:crypto";

export const AUTHORITATIVE_QUERY_TIMEOUT_MS = 5000;

export interface AuthoritativeTtlResult {
  ttlSeconds: number;
  server: string;
}

/** Encode a standard DNS A-record query with RD bit off. */
export function encodeDnsQuery(id: number, name: string): Buffer {
  const cleanName = name.replace(/\.$/, "");
  const labels = cleanName ? cleanName.split(".") : [];
  let nameLen = 1; // for trailing 0
  for (const label of labels) {
    nameLen += 1 + Buffer.byteLength(label, "ascii");
  }
  const buf = Buffer.alloc(12 + nameLen + 4);
  buf.writeUInt16BE(id & 0xffff, 0);
  buf.writeUInt16BE(0, 2); // Flags: QR=0, Opcode=0, AA=0, TC=0, RD=0, RA=0, Z=0, RCODE=0
  buf.writeUInt16BE(1, 4); // QDCOUNT = 1
  buf.writeUInt16BE(0, 6); // ANCOUNT = 0
  buf.writeUInt16BE(0, 8); // NSCOUNT = 0
  buf.writeUInt16BE(0, 10); // ARCOUNT = 0

  let offset = 12;
  for (const label of labels) {
    const len = Buffer.byteLength(label, "ascii");
    buf.writeUInt8(len, offset++);
    buf.write(label, offset, len, "ascii");
    offset += len;
  }
  buf.writeUInt8(0, offset++);
  buf.writeUInt16BE(1, offset); // QTYPE = 1 (A)
  offset += 2;
  buf.writeUInt16BE(1, offset); // QCLASS = 1 (IN)
  return buf;
}

function readName(buf: Buffer, offset: number): { name: string; bytesRead: number } {
  const labels: string[] = [];
  let curr = offset;
  let jumped = false;
  let bytesRead = 0;
  const visited = new Set<number>();
  let completed = false;

  while (curr < buf.length) {
    if (visited.has(curr)) {
      throw new Error("DNS pointer loop detected");
    }
    visited.add(curr);

    const len = buf.readUInt8(curr);
    if (len === 0) {
      curr += 1;
      if (!jumped) {
        bytesRead = curr - offset;
      }
      completed = true;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (curr + 1 >= buf.length) {
        throw new Error("Truncated DNS pointer");
      }
      const ptr = ((len & 0x3f) << 8) | buf.readUInt8(curr + 1);
      if (!jumped) {
        bytesRead = curr - offset + 2;
        jumped = true;
      }
      curr = ptr;
    } else if ((len & 0xc0) !== 0) {
      throw new Error(`Unsupported DNS label type: 0x${len.toString(16)}`);
    } else {
      curr += 1;
      if (curr + len > buf.length) {
        throw new Error("Truncated DNS label");
      }
      labels.push(buf.toString("ascii", curr, curr + len));
      curr += len;
    }
  }

  if (!completed) {
    throw new Error("Truncated DNS name");
  }

  return {
    name: labels.join("."),
    bytesRead,
  };
}

/** Parse a DNS response buffer and return the TTL of the first answer record matching name. */
export function answerTtl(response: Buffer, id: number, name: string): number {
  if (response.length < 12) {
    throw new Error(`DNS response for ${name} is too short (${response.length} bytes)`);
  }
  const respId = response.readUInt16BE(0);
  if (respId !== (id & 0xffff)) {
    throw new Error(`DNS response ID mismatch for ${name}: expected ${id & 0xffff}, got ${respId}`);
  }
  const flags = response.readUInt16BE(2);
  const qr = (flags >> 15) & 1;
  if (qr === 0) {
    throw new Error(`DNS message for ${name} is a query, not a response`);
  }
  const rcode = flags & 0x000f;
  if (rcode !== 0) {
    throw new Error(`DNS query for ${name} failed with rcode ${rcode}`);
  }

  const qdcount = response.readUInt16BE(4);
  const ancount = response.readUInt16BE(6);

  let offset = 12;
  // Skip Question section
  for (let i = 0; i < qdcount; i++) {
    const qName = readName(response, offset);
    offset += qName.bytesRead;
    if (offset + 4 > response.length) {
      throw new Error(`Truncated DNS question section for ${name}`);
    }
    offset += 4; // skip QTYPE and QCLASS
  }

  const targetName = name.replace(/\.$/, "").toLowerCase();

  // Parse Answer section
  for (let i = 0; i < ancount; i++) {
    const aName = readName(response, offset);
    offset += aName.bytesRead;
    if (offset + 10 > response.length) {
      throw new Error(`Truncated DNS answer header for ${name}`);
    }
    const ttl = response.readUInt32BE(offset + 4);
    const rdlength = response.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdlength > response.length) {
      throw new Error(`Truncated DNS answer rdata for ${name}`);
    }
    offset += rdlength;

    const ownerName = aName.name.replace(/\.$/, "").toLowerCase();
    if (ownerName === targetName) {
      return ttl;
    }
  }

  throw new Error(`no answer record for ${name} in DNS response`);
}

/** Look up the authoritative nameserver for name and query it over UDP for the served TTL. */
export async function readAuthoritativeTtl(
  name: string,
  signal: AbortSignal,
): Promise<AuthoritativeTtlResult> {
  const cleanName = name.replace(/\.$/, "");
  const labels = cleanName ? cleanName.split(".") : [];
  let nsName: string | undefined;

  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    try {
      const nsList = await dns.promises.resolveNs(candidate);
      if (nsList && nsList.length > 0) {
        nsName = nsList[0];
        break;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENODATA" || code === "ENOTFOUND") {
        continue;
      }
      throw err;
    }
  }

  if (!nsName) {
    throw new Error(`no authoritative nameserver found for ${name}`);
  }

  const ips = await dns.promises.resolve4(nsName);
  if (!ips || ips.length === 0) {
    throw new Error(`no IPv4 address for nameserver ${nsName}`);
  }
  const serverIp = ips[0]!;

  const id = crypto.randomInt(0, 65536);
  const query = encodeDnsQuery(id, name);

  const ttlSeconds = await new Promise<number>((resolve, reject) => {
    if (signal.aborted) {
      return reject(signal.reason ?? new Error("Aborted"));
    }

    const socket = dgram.createSocket("udp4");
    let settled = false;

    const timer = setTimeout(() => {
      settleReject(new Error(`authoritative DNS query for ${name} to ${serverIp} (${nsName}) timed out after ${AUTHORITATIVE_QUERY_TIMEOUT_MS} ms`));
    }, AUTHORITATIVE_QUERY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.close();
    };

    const settleResolve = (val: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      settleReject(signal.reason ?? new Error("Aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    socket.on("error", (err) => {
      settleReject(err);
    });

    socket.on("message", (msg) => {
      try {
        const ttl = answerTtl(msg, id, name);
        settleResolve(ttl);
      } catch (err) {
        settleReject(err);
      }
    });

    socket.send(query, 53, serverIp, (err) => {
      if (err) {
        settleReject(err);
      }
    });
  });

  return { ttlSeconds, server: nsName };
}
