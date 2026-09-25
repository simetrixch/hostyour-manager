// The TCP door probe over node:net: one connect, closed at once, every failure named.
import { createConnection } from "node:net";
import type { TcpProbe, TcpReach } from "./port.ts";

/** A connect error, in words: the three a moved or vanished machine answers with, and the code as it
 *  came for anything else. */
export function reasonOf(code: string | undefined, host: string, port: number): string {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `the name ${host} does not resolve`;
    case "ECONNREFUSED":
      return `${host} refuses connections on port ${port}`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `there is no route to ${host}`;
    default:
      return `the connect to ${host}:${port} failed (${code ?? "no code"})`;
  }
}

export class NetTcpProbe implements TcpProbe {
  reach(input: { host: string; port: number; timeoutMs: number }): Promise<TcpReach> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: input.host, port: input.port });
      const done = (answer: TcpReach): void => {
        socket.destroy();
        resolve(answer);
      };
      socket.setTimeout(input.timeoutMs, () => done({ reachable: false, reason: `nothing answers on ${input.host}:${input.port} within ${Math.round(input.timeoutMs / 1000)}s` }));
      socket.once("connect", () => done({ reachable: true }));
      socket.once("error", (err: NodeJS.ErrnoException) => done({ reachable: false, reason: reasonOf(err.code, input.host, input.port) }));
    });
  }
}
