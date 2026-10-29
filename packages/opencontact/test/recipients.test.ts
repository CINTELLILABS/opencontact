import { describe, expect, it } from "vitest";
import { parseRecipients, recipientContext } from "../src/recipients.ts";

describe("parseRecipients", () => {
  it("reads a CSV with a header, finds phone and name columns, keeps the rest as details", () => {
    const { recipients, skipped } = parseRecipients(
      [
        "Name,Phone,Appointment",
        'Sam Lee,(415) 555-0134,"Thu, 4:30"',
        "Priya,+1 415 555 0199,",
        "Bad,not-a-number,x",
      ].join("\n"),
    );
    expect(recipients).toEqual([
      { handle: "+14155550134", name: "Sam Lee", details: { appointment: "Thu, 4:30" } },
      { handle: "+14155550199", name: "Priya", details: {} },
    ]);
    expect(skipped).toEqual(["Bad,not-a-number,x"]);
  });
  it("reads a plain list of numbers, skips comments and duplicates", () => {
    const { recipients } = parseRecipients("# team\n4155550134\n+14155550134\nsam@example.com\n");
    expect(recipients.map((r) => r.handle)).toEqual(["+14155550134", "sam@example.com"]);
  });
  it("builds the agent's context per person", () => {
    expect(
      recipientContext("remind them about this week", {
        handle: "+1",
        name: "Sam",
        details: { appointment: "Thu 4:30" },
      }),
    ).toBe(
      "remind them about this week The recipient's name is Sam. Details for this recipient: appointment: Thu 4:30.",
    );
  });
});
