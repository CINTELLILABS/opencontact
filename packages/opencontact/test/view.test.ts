import { describe, expect, it } from "vitest";
import { formatHandle, LiveView, visibleWidth, wrap } from "../src/view.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("wrap and width", () => {
  it("wraps on words and breaks words longer than the line", () => {
    expect(wrap("We do, PPO and Premier. Want me to book a cleaning?", 20)).toEqual([
      "We do, PPO and",
      "Premier. Want me to",
      "book a cleaning?",
    ]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("counts emoji as two cells and ignores ANSI", () => {
    expect(visibleWidth("hi 🙌")).toBe(5);
    expect(visibleWidth("\x1b[1mbold\x1b[0m")).toBe(4);
  });
  it("formats US numbers", () => {
    expect(formatHandle("+14155550134")).toBe("(415) 555-0134");
    expect(formatHandle("a@b.co")).toBe("a@b.co");
  });
});

describe("LiveView", () => {
  const make = () =>
    new LiveView({
      title: "opencontact",
      brain: "Bland",
      answers: "everyone",
      cardName: "Acme Dental",
      dryRun: false,
      nameOf: (h) => (h === "+14155550134" ? "Sam" : formatHandle(h)),
      now: () => new Date(2026, 9, 29, 16, 12),
    });

  it("draws the header, an inbound bubble on the left, the reply and card on the right, and fills the screen", () => {
    const v = make();
    v.inbound("+14155550134", "do you take Delta Dental?");
    v.thinking("+14155550134");
    v.reply("+14155550134", "Yes, PPO and Premier. Want me to book Thursday at 4:30?", false);
    v.card("+14155550134", false);
    const lines = v.lines(90, 24);
    expect(lines).toHaveLength(24);
    const plain = lines.map(strip);
    expect(plain[0]).toMatch(/opencontact .*Bland .*answers everyone .*● LIVE/);
    const inIdx = plain.findIndex((l) => l.includes("do you take Delta Dental?"));
    expect(plain[inIdx]?.startsWith("   do you take")).toBe(true);
    expect(plain.some((l) => l.trimStart().startsWith("Sam") && l.includes("4:12"))).toBe(true);
    const outLine = plain.find((l) => l.includes("Yes, PPO and Premier."));
    expect(outLine && outLine.indexOf("Yes") > 20).toBe(true);
    expect(plain.some((l) => l.includes("◉ Acme Dental · contact card"))).toBe(true);
    expect(plain.at(-1)).toMatch(/waiting for texts .*1 in · 1 sent · 1 card/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(90);
  });

  it("shows typing dots for a contact while the brain thinks", () => {
    const v = make();
    v.inbound("+14155550134", "hi");
    v.thinking("+14155550134");
    expect(strip(v.lines(90, 20).at(-1) ?? "")).toMatch(/replying to Sam [●○]{3}/);
  });

  it("marks dry-run replies", () => {
    const v = make();
    v.reply("+14155550134", "hello", true);
    expect(
      v
        .lines(90, 12)
        .map(strip)
        .some((l) => l.includes("DRY RUN · would send to Sam")),
    ).toBe(true);
  });
});
