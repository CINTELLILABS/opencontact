/**
 * The setup screens: step headers, live tasks with a timer, and boxed panels.
 * Everything goes to stderr, like prompt.ts, and falls back to plain lines
 * when stderr is not a terminal.
 */
import { truncate, visibleWidth, wrap } from "./view.ts";

const tty = () => Boolean(process.stderr.isTTY);
const out = (s: string) => process.stderr.write(s);
const cols = () => Math.max(40, Math.min(process.stderr.columns ?? 80, 100));
/** Every box on the setup screen shares one width. */
const boxWidth = () => Math.min(cols() - 4, 72);

const esc = (code: string) => (s: string) => (tty() ? `\x1b[${code}m${s}\x1b[0m` : s);
const truecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
/** A brand color: exact where the terminal can show it, the nearest of the 256 colors elsewhere. */
const hue = (hex: string, fallback: number) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return (s: string) => esc(truecolor() ? `38;2;${r};${g};${b}` : `38;5;${fallback}`)(s);
};

/** Bland's palette, from bland.ai: near-black and warm grays, one red-orange accent, green for success. */
export const brand = {
  accent: hue("#d8441f", 166),
  green: hue("#048244", 29),
  warm: hue("#ddddd5", 253),
};

export const tone = {
  bold: esc("1"),
  dim: esc("2"),
  green: brand.green,
  yellow: hue("#c98a00", 172),
  red: hue("#c4321b", 160),
  accent: brand.accent,
  link: esc("4"),
  faint: esc("38;5;244"),
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function seconds(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The title block at the top of setup. */
export function banner(version: string, tagline: string): void {
  const width = boxWidth();
  const title = `${tone.bold("opencontact")} ${tone.faint("by")} ${tone.bold("Bland")}  ${tone.faint(`v${version}`)}`;
  const line = (s: string) =>
    `  ${tone.faint("│")}  ${s}${" ".repeat(Math.max(0, width - 4 - visibleWidth(s)))}${tone.faint("│")}`;
  out("\n");
  out(`  ${tone.faint(`╭${"─".repeat(width - 2)}╮`)}\n`);
  out(`${line(title)}\n`);
  for (const piece of wrap(tagline, width - 6)) out(`${line(tone.dim(piece))}\n`);
  out(`  ${tone.faint(`╰${"─".repeat(width - 2)}╯`)}\n`);
}

/** "◆ Your agent ▰▰▰▱▱ 3 of 5" */
export function stepHeader(n: number, total: number, title: string): void {
  const rail = `${tone.accent("▰".repeat(n))}${tone.faint("▱".repeat(Math.max(0, total - n)))}`;
  out(`\n  ${tone.accent("◆")} ${tone.bold(title)}  ${rail} ${tone.faint(`${n} of ${total}`)}\n`);
}

export interface Task {
  /** A second, dimmer line under the task: what it is doing right now. */
  detail(text: string): void;
  /** 0 to 1 draws a bar on the detail line; undefined hides it. */
  progress(fraction: number | undefined): void;
  done(text?: string): void;
  warn(text: string): void;
  fail(text: string): void;
}

/** A live line with a spinner and a timer, finished with ✓, ! or ✗. */
export function task(label: string): Task {
  const started = Date.now();
  let detail = "";
  let fraction: number | undefined;
  let frame = 0;
  let drawn = 0;
  let finished = false;

  const clear = () => {
    if (drawn === 0) return;
    out(`\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(drawn - 1)}`);
    drawn = 0;
  };
  const render = () => {
    const width = cols() - 4;
    const time = tone.faint(seconds(Date.now() - started));
    const head = truncate(label, width - 12);
    const lines = [`  ${brand.accent(FRAMES[frame % FRAMES.length] as string)} ${head}  ${time}`];
    if (detail || fraction !== undefined) {
      const barWidth = fraction === undefined ? 0 : Math.min(24, Math.floor(width / 4));
      const filled = Math.round((fraction ?? 0) * barWidth);
      const bar = barWidth ? `${brand.accent("━".repeat(filled))}${tone.faint("━".repeat(barWidth - filled))}  ` : "";
      lines.push(`    ${bar}${tone.dim(truncate(detail, width - barWidth - 6))}`);
    }
    clear();
    out(lines.join("\n"));
    drawn = lines.length;
  };

  if (!tty()) out(`  ${label}…\n`);
  const timer = tty() ? setInterval(() => (frame++, render()), 80) : undefined;
  if (tty()) render();

  const finish = (mark: string, text: string | undefined) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    clear();
    out(`  ${mark} ${text ?? label}  ${tone.faint(seconds(Date.now() - started))}\n`);
  };
  return {
    detail(text) {
      detail = text;
      if (!tty() && text) out(`    ${text}\n`);
    },
    progress(f) {
      fraction = f === undefined ? undefined : Math.max(0, Math.min(1, f));
    },
    done: (text) => finish(tone.green("✓"), text),
    warn: (text) => finish(tone.yellow("!"), text),
    fail: (text) => finish(tone.red("✗"), text),
  };
}

/** A rounded box with a title in its top edge; long lines wrap inside it. */
export function panel(title: string, body: string[]): void {
  const width = boxWidth();
  const inner = width - 4;
  const rule = "─".repeat(Math.max(0, width - visibleWidth(title) - 5));
  out(`\n  ${tone.faint("╭─ ")}${tone.bold(title)}${tone.faint(` ${rule}╮`)}\n`);
  const row = (s: string) =>
    out(`  ${tone.faint("│")} ${s}${" ".repeat(Math.max(0, inner - visibleWidth(s)))} ${tone.faint("│")}\n`);
  for (const line of body.flatMap((l) => l.split("\n"))) {
    if (line === "") row("");
    // Lines that fit keep their spacing (labels, bullets); only long text wraps.
    else if (visibleWidth(line) <= inner) row(line);
    else for (const piece of wrap(line, inner)) row(piece);
  }
  out(`  ${tone.faint(`╰${"─".repeat(width - 2)}╯`)}\n`);
}

/** "label   value" rows for a panel. */
export function field(label: string, value: string): string {
  const pad = 11;
  const lines = wrap(value, boxWidth() - 4 - pad);
  return lines.map((v, i) => (i === 0 ? `${tone.faint(label.padEnd(pad))}${v}` : `${" ".repeat(pad)}${v}`)).join("\n");
}

/** A finished line: "✓ text". */
export function ok(text: string): void {
  out(`  ${tone.green("✓")} ${text}\n`);
}

/** Something to know before going on: "! text". */
export function caution(text: string): void {
  out(`  ${tone.yellow("!")} ${text}\n`);
}
