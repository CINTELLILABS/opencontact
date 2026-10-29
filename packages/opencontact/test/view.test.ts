import { describe, expect, it } from "vitest";
import { formatHandle, LiveView, truncate, visibleWidth, wrap } from "../src/view.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("text helpers", () => {
  it("wraps on words and breaks words longer than the line", () => {
    expect(wrap("We do, PPO and Premier. Want me to book a cleaning?", 20)).toEqual([
      "We do, PPO and",
      "Premier. Want me to",
      "book a cleaning?",
    ]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("counts emoji as two cells, ignores ANSI, truncates with an ellipsis", () => {
    expect(visibleWidth("hi 🙌")).toBe(5);
    expect(visibleWidth("\x1b[1mbold\x1b[0m")).toBe(4);
    expect(truncate("Hello there friend", 8)).toBe("Hello t…");
  });
  it("formats US numbers", () => {
    expect(formatHandle("+14155550134")).toBe("(415) 555-0134");
  });
});

const SAM = "+14155550134";
const PRIYA = "+14155550199";

function make(actions?: Partial<import("../src/view.ts").ViewActions>) {
  const calls: string[] = [];
  const v = new LiveView({
    title: "opencontact",
    brain: "Bland",
    answers: "everyone",
    cardName: "Acme Dental",
    dryRun: false,
    nameOf: (h) => (h === SAM ? "Sam" : h === PRIYA ? "Priya" : formatHandle(h)),
    now: () => new Date(2026, 9, 29, 16, 12),
    actions: {
      send: async (h, t) => {
        calls.push(`send ${h} ${t}`);
      },
      setManual: (h, on) => calls.push(`manual ${h} ${on}`),
      setDryRun: (d) => calls.push(`dry ${d}`),
      quit: () => calls.push("quit"),
      ...actions,
    },
    // Keep the screen out of the test output.
    out: { write: () => true, columns: 110, rows: 30 } as unknown as NodeJS.WriteStream,
  });
  return { v, calls };
}

describe("LiveView", () => {
  it("lists conversations in a sidebar and shows the followed one as bubbles", () => {
    const { v } = make();
    v.inbound(SAM, "do you take Delta Dental?");
    v.thinking(SAM);
    v.reply(SAM, "Yes, PPO and Premier. Want me to book Thursday at 4:30?", false);
    v.card(SAM, false);
    v.inbound(PRIYA, "can I move my cleaning?");
    const lines = v.lines(110, 30);
    expect(lines).toHaveLength(30);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(110);
    const plain = lines.map(strip).join("\n");
    expect(plain).toMatch(/opencontact .*Bland .*answers everyone .*● LIVE/);
    expect(plain).toContain("CONVERSATIONS");
    expect(plain).toMatch(/Sam\s+AI/);
    // Following: the latest activity (Priya) is the open thread.
    expect(plain).toMatch(/Priya\s+\(415\) 555-0199\s+● agent is answering/);
    expect(plain).toContain("can I move my cleaning?");
    expect(plain).not.toContain("Yes, PPO and Premier");
  });

  it("switches threads with the arrow keys and stops following", () => {
    const { v } = make();
    v.reply(SAM, "Hi Sam, this is Acme Dental.", false, true);
    v.inbound(PRIYA, "hello");
    v.key("\x1b[B");
    const plain = v.lines(110, 30).map(strip).join("\n");
    expect(plain).toContain("Hi Sam, this is Acme Dental.");
    expect(plain).toContain("agent · reached out");
    expect(plain).not.toContain("following");
    v.inbound(PRIYA, "still there?");
    expect(v.lines(110, 30).map(strip).join("\n")).toContain("Hi Sam, this is Acme Dental.");
  });

  it("lets the owner write into a conversation, which pauses the agent there", async () => {
    const { v, calls } = make();
    v.inbound(SAM, "can I talk to a person?");
    v.key("\r");
    for (const ch of "Hey Sam, it's Raj") v.key(ch);
    expect(strip(v.lines(110, 30).at(-2) ?? "")).toContain("to Sam › Hey Sam, it's Raj");
    v.key("\r");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain(`manual ${SAM} true`);
    expect(calls).toContain(`send ${SAM} Hey Sam, it's Raj`);
    const plain = v.lines(110, 30).map(strip).join("\n");
    expect(plain).toContain("● you have this conversation");
    expect(plain).toMatch(/Sam\s+YOU/);
    v.key("a");
    expect(calls).toContain(`manual ${SAM} false`);
    expect(v.lines(110, 30).map(strip).join("\n")).toContain("● agent is answering");
  });

  it("does not quit on q while typing, and Esc cancels", () => {
    const { v, calls } = make();
    v.inbound(SAM, "hi");
    v.key("\r");
    v.key("q");
    expect(calls).not.toContain("quit");
    v.key("\x1b");
    v.key("q");
    expect(calls).toContain("quit");
  });

  it("shows typing dots and dry-run replies", () => {
    const { v } = make();
    v.inbound(SAM, "hi");
    v.thinking(SAM);
    expect(v.lines(110, 30).map(strip).join("\n")).toMatch(/Sam\s+[●○]{3}/);
    v.reply(SAM, "hello", true);
    expect(v.lines(110, 30).map(strip).join("\n")).toContain("agent · DRY RUN, not sent");
  });
});
