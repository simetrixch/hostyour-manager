import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterActions } from "./MasterActions.tsx";

// The master's card offers `cluster-redeploy` only where it is handed the act, which the servers page
// does for a master whose cluster is live.
describe("MasterActions", () => {
  const offer = { read: false, disconnect: false, reconnect: false, rejoin: false };
  const noop = (): void => undefined;
  const render = (onRedeploy?: () => void): string =>
    renderToStaticMarkup(createElement(MasterActions, {
      parts: "master carries the master part",
      offer,
      onRead: noop,
      onDisconnect: noop,
      onReconnect: noop,
      onRejoin: noop,
      ...(onRedeploy ? { onRedeploy } : {}),
    }));

  it("offers Redeploy when it is handed the act", () => {
    expect(render(noop)).toContain(">Redeploy</button>");
  });

  it("offers no Redeploy when it is not", () => {
    expect(render()).not.toContain("Redeploy");
  });
});
