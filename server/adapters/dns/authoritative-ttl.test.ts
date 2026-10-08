import * as dgram from "node:dgram";
import { describe, it, expect } from "vitest";
import { encodeDnsQuery, answerTtl, NotAuthoritativeError, queryAuthoritative } from "./authoritative-ttl.ts";

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
    aa?: boolean;
    ownerPointerOffset?: number | "self";
    ttl?: number;
  } = {}): Buffer {
    const id = opts.id ?? 0x1234;
    const rcode = opts.rcode ?? 0;
    const qr = opts.qr ?? 1;
    const aa = opts.aa ?? true;
    const ttl = opts.ttl ?? 300;

    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    const flags = (qr << 15) | (aa ? 0x0400 : 0) | (rcode & 0x000f);
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

    const answerOffset = header.length + question.length;
    const ownerPointer = opts.ownerPointerOffset === "self" ? answerOffset : (opts.ownerPointerOffset ?? 12);

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
    expect(() => answerTtl(response, 0x1234, "a.example.org")).not.toThrow(NotAuthoritativeError);
  });

  it("throws when query id does not match response id", () => {
    const response = buildTestResponse({ id: 0x1234 });
    expect(() => answerTtl(response, 0x9999, "a.example.org")).toThrow(
      /ID mismatch/,
    );
  });

  it("throws when a pointer loop is detected in the answer name", () => {
    const response = buildTestResponse({ ownerPointerOffset: "self" });
    expect(() => answerTtl(response, 0x1234, "a.example.org")).toThrow(/pointer loop/);
  });

  it("throws when answer rdata is truncated", () => {
    const valid = buildTestResponse({ id: 0x1234, ttl: 300 });
    const truncated = valid.subarray(0, valid.length - 2);
    expect(() => answerTtl(truncated, 0x1234, "a.example.org")).toThrow(/Truncated DNS answer rdata/);
  });

  it("throws NotAuthoritativeError when AA bit is missing", () => {
    const response = buildTestResponse({ id: 0x1234, aa: false });
    expect(() => answerTtl(response, 0x1234, "a.example.org")).toThrow(NotAuthoritativeError);
  });

  it("throws NotAuthoritativeError when RCODE is 5 (REFUSED)", () => {
    const response = buildTestResponse({ id: 0x1234, rcode: 5 });
    expect(() => answerTtl(response, 0x1234, "a.example.org")).toThrow(NotAuthoritativeError);
  });

  it("ignores a stray datagram with wrong id and resolves when the right answer arrives", async () => {
    const server = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", () => resolve());
    });
    const serverPort = server.address().port;

    server.on("message", (query, rinfo) => {
      const queryId = query.readUInt16BE(0);
      const wrongResponse = buildTestResponse({ id: (queryId + 1) & 0xffff, ttl: 999 });
      server.send(wrongResponse, rinfo.port, rinfo.address, () => {
        const rightResponse = buildTestResponse({ id: queryId, ttl: 120 });
        server.send(rightResponse, rinfo.port, rinfo.address);
      });
    });

    try {
      const controller = new AbortController();
      const ttl = await queryAuthoritative("127.0.0.1", serverPort, "a.example.org", controller.signal, 2000);
      expect(ttl).toBe(120);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("ignores a datagram arriving from a different port", async () => {
    const server = dgram.createSocket("udp4");
    const otherServer = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => {
      server.bind(0, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => {
      otherServer.bind(0, "127.0.0.1", () => resolve());
    });
    const serverPort = server.address().port;

    server.on("message", (query, rinfo) => {
      const queryId = query.readUInt16BE(0);
      const wrongPortResponse = buildTestResponse({ id: queryId, ttl: 999 });
      otherServer.send(wrongPortResponse, rinfo.port, rinfo.address, () => {
        setTimeout(() => {
          const rightResponse = buildTestResponse({ id: queryId, ttl: 240 });
          server.send(rightResponse, rinfo.port, rinfo.address);
        }, 50);
      });
    });

    try {
      const controller = new AbortController();
      const ttl = await queryAuthoritative("127.0.0.1", serverPort, "a.example.org", controller.signal, 2000);
      expect(ttl).toBe(240);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        otherServer.close(() => resolve());
      });
    }
  });
});

