import { describe, it, expect } from "vitest";
import { MACHINE_PASSWORD_SECRET } from "../../shared/approve.ts";
import { secretFieldLabel, secretFieldHint } from "./approveFields.ts";

// The approve card is where a person hands over the password of an account on one of their machines.
// What they read above the box is the whole of what they have to go on, so it is measured here — and
// what is measured is that the key never reaches the screen as the question.

describe("secretFieldLabel — what a credential field is called", () => {
  it("names the machine account's password instead of the key it rides under", () => {
    const label = secretFieldLabel(MACHINE_PASSWORD_SECRET);
    expect(label).not.toContain(MACHINE_PASSWORD_SECRET);
    expect(label).toMatch(/password of the machine account/);
  });

  it("shows a consumer's own secret under the name its manifest declares", () => {
    expect(secretFieldLabel("consumer-secret:SMTP_PASSWORD")).toBe("SMTP_PASSWORD");
  });

  it("shows any other key as the plan states it, rather than inventing a word for it", () => {
    expect(secretFieldLabel("tenant-storage:key")).toBe("tenant-storage:key");
  });
});

describe("secretFieldHint — what the credential is spent on", () => {
  it("says what the machine account's password does, for every run kind that asks for it", () => {
    expect(secretFieldHint(MACHINE_PASSWORD_SECRET)).toMatch(/raised with it/);
  });

  it("adds nothing under a key whose own name is the whole of what can be said", () => {
    expect(secretFieldHint("consumer-secret:SMTP_PASSWORD")).toBeNull();
    expect(secretFieldHint("tenant-storage:key")).toBeNull();
  });
});
