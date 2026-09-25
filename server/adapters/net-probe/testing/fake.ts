import type { TcpProbe, TcpReach } from "../port.ts";

/** Answers per `host:port` what a test states; a door nobody stated is taken. */
export class FakeTcpProbe implements TcpProbe {
  readonly answers = new Map<string, TcpReach>();
  readonly asked: string[] = [];

  async reach(input: { host: string; port: number; timeoutMs: number }): Promise<TcpReach> {
    const door = `${input.host}:${input.port}`;
    this.asked.push(door);
    return this.answers.get(door) ?? { reachable: true };
  }
}
