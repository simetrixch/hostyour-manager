import { describe, it, expect } from "vitest";
import { encodeDnsQuery, answerTtl } from "./authoritative-ttl.ts";

describe("authoritative-ttl", () => {
  it("encodes a.example.org as the expected bytes", () => {
    const id = 0x1234;
    const buf = encodeDnsQuery(id, "a.example.org");
    const expected = Buffer.from([
      0x12, 0x34, // ID
      0x00, 0x00, // Flags: RD=0
      0x00, 0x01, // QDCOUNT = 1
      0x00, 0x00, // ANCOUNT = 0
      0x00, 0x00, // NSCOUNT = 0
      0x00, 0x00, // ARCOUNT = 0
      0x01, 0x61, // 'a'
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, // 'example'
      0x03, 0x6f, 0x72, 0x67, // 'org'
      0x00, // null terminator
      0x00, 0x01, // QTYPE = 1 (A)
      0x00, 0x01, // QCLASS = 1 (IN)
    ]);
    expect(buf).toEqual(expected);
  });

  function buildTestResponse(opts: {
    id?: number;
    rcode?: number;
    qr?: number;
    ownerPointerOffset?: number;
    ttl?: number;
  } = {}): Buffer {
    const id = opts.id ?? 0x1234;
    const rcode = opts.rcode ?? 0;
    const qr = opts.qr ?? 1;
    const ttl = opts.ttl ?? 300;
    const ownerPointer = opts.ownerPointerOffset ?? 12;

    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    const flags = (qr << 15) | (rcode & 0x000f);
    header.writeUInt16BE(flags, 2);
    header.writeUInt16BE(1, 4); // QDCOUNT = 1
    header.writeUInt16BE(1, 6); // ANCOUNT = 1

    const question = Buffer.from([
      0x01, 0x61, // 'a'
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, // 'example'
      0x03, 0x6f, 0x72, 0x67, // 'org'
      0x00,
      0x00, 0x01, // QTYPE A
      0x00, 0x01, // QCLASS IN
    ]);

    const answer = Buffer.alloc(16);
    // Compression pointer
    answer.writeUInt8(0xc0 | ((ownerPointer >> 8) & 0x3f), 0);
    answer.writeUInt8(ownerPointer & 0xff, 1);
    answer.writeUInt16BE(5, 2); // TYPE = CNAME
    answer.writeUInt16BE(1, 4); // CLASS = IN
    answer.writeUInt32BE(ttl, 6); // TTL
    answer.writeUInt16BE(4, 10); // RDLENGTH = 4
    answer.fill(0xaa, 12, 16); // RDATA

    return Buffer.concat([header, question, answer]);
  }

  it("extracts TTL from a response with a CNAME answer using compression pointer", () => {
    const response = buildTestResponse({ id: 0x1234, ttl: 300 });
    expect(answerTtl(response, 0x1234, "a.example.org")).toBe(300);
  });

  it("throws when answer owner is another name", () => {
    const response = buildTestResponse({ id: 0x1234, ttl: 300 });
    expect(() => answerTtl(response, 0x1234, "other.example.org")).toThrow(
      /no answer record for other\.example\.org/,
    );
  });

  it("throws when RCODE is 3", () => {
    const response = buildTestResponse({ id: 0x1234, rcode: 3 });
    expect(() => answerTtl(response, 0x1234, "a.example.org")).toThrow(
      /rcode 3/,
    );
  });

  it("throws when query id does not match response id", () => {
    const response = buildTestResponse({ id: 0x1234 });
    expect(() => answerTtl(response, 0x9999, "a.example.org")).toThrow(
      /ID mismatch/,
    );
  });
});
