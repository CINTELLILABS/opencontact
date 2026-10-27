import { describe, expect, it } from "vitest";
import { inferOwnHandle, isEmailHandle, isPhoneHandle, maskHandle, normalizeHandle } from "../src/handles.ts";

describe("normalizeHandle", () => {
  it("keeps E.164 and strips punctuation", () => {
    expect(normalizeHandle("+1 (415) 555-1212")).toBe("+14155551212");
    expect(normalizeHandle("+14155551212")).toBe("+14155551212");
  });
  it("assumes US for bare 10 digits and 1-prefixed 11 digits", () => {
    expect(normalizeHandle("4155551212")).toBe("+14155551212");
    expect(normalizeHandle("14155551212")).toBe("+14155551212");
  });
  it("lower-cases emails", () => {
    expect(normalizeHandle("  Owner@Example.COM ")).toBe("owner@example.com");
  });
  it("classifies", () => {
    expect(isPhoneHandle("+14155551212")).toBe(true);
    expect(isPhoneHandle("4155551212")).toBe(false);
    expect(isEmailHandle("a@b.co")).toBe(true);
  });
  it("masks all but the last four", () => {
    expect(maskHandle("+14155551212")).toBe("********1212");
    expect(maskHandle("abc")).toBe("****");
  });
});

describe("inferOwnHandle", () => {
  it("picks the most common addressed handle, preferring a phone over an email", () => {
    const chats = [
      { last_addressed_handle: "+1 (415) 555-7458" },
      { last_addressed_handle: "+14155557458" },
      { last_addressed_handle: "raj@example.com" },
      { last_addressed_handle: "raj@example.com" },
      { last_addressed_handle: "raj@example.com" },
      {},
    ];
    expect(inferOwnHandle(chats)).toBe("+14155557458");
    expect(inferOwnHandle([{ last_addressed_handle: "a@b.co" }])).toBe("a@b.co");
    expect(inferOwnHandle([{}, { last_addressed_handle: "" }])).toBeNull();
  });
});
