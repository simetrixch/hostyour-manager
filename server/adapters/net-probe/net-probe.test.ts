import { describe, it, expect } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { NetTcpProbe, reasonOf } from "./net-probe.ts";

describe("NetTcpProbe", () => {
  it("answers reachable where a port takes the connection, and names a refusal where none listens", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const probe = new NetTcpProbe();
    expect(await probe.reach({ host: "127.0.0.1", port, timeoutMs: 2_000 })).toEqual({ reachable: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probe.reach({ host: "127.0.0.1", port, timeoutMs: 2_000 })).toEqual({ reachable: false, reason: `127.0.0.1 refuses connections on port ${port}` });
  });

  it("names the three answers a moved or vanished machine gives, and the code for any other", () => {
    expect(reasonOf("ENOTFOUND", "s1.example.com", 22)).toBe("the name s1.example.com does not resolve");
    expect(reasonOf("ECONNREFUSED", "s1.example.com", 22)).toBe("s1.example.com refuses connections on port 22");
    expect(reasonOf("EHOSTUNREACH", "s1.example.com", 22)).toBe("there is no route to s1.example.com");
    expect(reasonOf("EPIPE", "s1.example.com", 22)).toBe("the connect to s1.example.com:22 failed (EPIPE)");
  });
});
