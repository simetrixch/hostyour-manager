import { expect, it, vi } from "vitest";

vi.mock("react-router", async (original) => ({ ...(await original<typeof import("react-router")>()), useParams: () => ({ id: "tnt_t" }) }));
const { TenantDetailOfRow } = await import("./App.tsx");

it("mounts one tenant page per row the URL names", () => {
  expect(TenantDetailOfRow().key).toBe("tnt_t");
});
