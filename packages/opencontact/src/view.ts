/**
 * The live view for `opencontact run`: conversations as chat bubbles, typing
 * dots while the brain thinks, a status bar. ANSI only, no dependencies. It
 * owns the screen while it runs (alternate buffer) and gives it back on stop.
 */

export type FeedItem =
  | { kind: "in"; handle: string; text: string; at: Date }
  | { kind: "out"; handle: string; text: string; at: Date; dryRun: boolean; fromList?: boolean }
  | { kind: "card"; handle: string; at: Date; dryRun: boolean }
  | { kind: "note"; text: string; at: Date; tone?: "dim" | "warn" | "error" };

export interface ViewOptions {
  title: string;
  brain: string;
  answers: string;
  cardName?: string | undefined;
  dryRun: boolean;
  /** Display name for a handle (a saved list name, a contact name, or a formatted number). */
  nameOf: (handle: string) => string;
  out?: NodeJS.WriteStream;
  now?: () => Date;
}

const ESC = "\x1b[";
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  fg: (n: number) => `${ESC}38;5;${n}m`,
  bg: (n: number) => `${ESC}48;5;${n}m`,
};

/** Visible width: ANSI stripped, wide emoji counted as two cells. */
export function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || (cp >= 0x200b && cp <= 0x200d)) continue;
    w += cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) ? 2 : 1;
  }
  return w;
}

/** Word-wrap plain text to lines of at most `width` cells. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (visibleWidth(word) > width) {
        if (line) out.push(line);
        let chunk = "";
        for (const ch of word) {
          if (visibleWidth(chunk + ch) > width) {
            out.push(chunk);
            chunk = "";
          }
          chunk += ch;
        }
        line = chunk;
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (visibleWidth(next) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

export function formatHandle(handle: string): string {
  const m = handle.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : handle;
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const DOTS = ["●○○", "○●○", "○○●", "○●○"];

export class LiveView {
  private readonly feed: FeedItem[] = [];
  private readonly typing = new Map<string, number>();
  private readonly out: NodeJS.WriteStream;
  private readonly now: () => Date;
  private dryRun: boolean;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private stats = { in: 0, out: 0, cards: 0 };

  constructor(private readonly opts: ViewOptions) {
    this.out = opts.out ?? process.stdout;
    this.now = opts.now ?? (() => new Date());
    this.dryRun = opts.dryRun;
  }

  start(): void {
    this.out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    this.out.on("resize", this.onResize);
    this.timer = setInterval(() => {
      this.frame += 1;
      if (this.typing.size > 0) this.render();
    }, 280);
    this.timer.unref?.();
    this.note("watching Messages. Text this number, or run `opencontact text` in another tab.");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.out.off("resize", this.onResize);
    this.out.write(`${c.reset}${ESC}?25h${ESC}?1049l`);
  }

  setDryRun(value: boolean): void {
    this.dryRun = value;
    this.note(value ? "dry-run: replies show here, nothing is sent" : "live: replies go out through Messages");
  }

  inbound(handle: string, text: string): void {
    this.stats.in += 1;
    this.push({ kind: "in", handle, text, at: this.now() });
  }

  thinking(handle: string): void {
    this.typing.set(handle, Date.now());
    this.schedule();
  }

  reply(handle: string, text: string, dryRun: boolean, fromList = false): void {
    this.typing.delete(handle);
    if (!dryRun) this.stats.out += 1;
    this.push({ kind: "out", handle, text, at: this.now(), dryRun, fromList });
  }

  card(handle: string, dryRun: boolean): void {
    if (!dryRun) this.stats.cards += 1;
    this.push({ kind: "card", handle, at: this.now(), dryRun });
  }

  done(handle: string): void {
    this.typing.delete(handle);
    this.schedule();
  }

  note(text: string, tone: "dim" | "warn" | "error" = "dim"): void {
    this.push({ kind: "note", text, at: this.now(), tone });
  }

  /** The lines of the screen, without writing them. Public for tests. */
  lines(cols: number, rows: number): string[] {
    const width = Math.max(40, cols);
    const bubbleMax = Math.max(24, Math.min(58, Math.floor(width * 0.62)));
    const header = this.header(width);
    const footer = this.footer(width);
    const bodyRows = Math.max(1, rows - header.length - footer.length);

    const body: string[] = [];
    for (const item of this.feed) {
      if (body.length > 0) body.push("");
      body.push(...this.renderItem(item, width, bubbleMax));
    }
    const visible = body.slice(-bodyRows);
    while (visible.length < bodyRows) visible.unshift("");
    return [...header, ...visible, ...footer];
  }

  private header(width: number): string[] {
    const mode = this.dryRun ? `${c.fg(220)}${c.bold}● DRY RUN` : `${c.fg(46)}${c.bold}● LIVE`;
    const left = ` ${c.bold}${this.opts.title}${c.reset}${c.bg(236)}${c.fg(250)}  ·  ${this.opts.brain}  ·  answers ${this.opts.answers}`;
    const right = `${mode}${c.reset}${c.bg(236)} `;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [`${c.bg(236)}${c.fg(255)}${left}${" ".repeat(gap)}${right}${c.reset}`, ""];
  }

  private footer(width: number): string[] {
    const typing = [...this.typing.keys()].map(
      (h) => `${this.opts.nameOf(h)} ${c.fg(39)}${DOTS[this.frame % DOTS.length]}${c.reset}${c.dim}`,
    );
    const activity = typing.length > 0 ? `replying to ${typing.join("   ")}` : "waiting for texts";
    const stats = `${this.stats.in} in · ${this.stats.out} sent · ${this.stats.cards} ${this.stats.cards === 1 ? "card" : "cards"}`;
    const left = ` ${c.dim}${activity}${c.reset}`;
    const right = `${c.dim}${stats}  ·  L live  D dry-run  Q quit ${c.reset}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return ["", `${c.dim}${"─".repeat(width)}${c.reset}`, `${left}${" ".repeat(gap)}${right}`];
  }

  private renderItem(item: FeedItem, width: number, bubbleMax: number): string[] {
    const name = (h: string) => this.opts.nameOf(h);
    if (item.kind === "note") {
      const color = item.tone === "error" ? c.fg(203) : item.tone === "warn" ? c.fg(214) : c.dim;
      const text = `${item.text}`;
      const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
      return [`${" ".repeat(pad)}${color}${text}${c.reset}`];
    }
    if (item.kind === "in") {
      const lines = wrap(item.text, bubbleMax - 2);
      const w = Math.max(...lines.map(visibleWidth));
      return [
        `  ${c.bold}${name(item.handle)}${c.reset}  ${c.dim}${clock(item.at)}${c.reset}`,
        ...lines.map((l) => `  ${c.bg(238)}${c.fg(255)} ${l}${" ".repeat(w - visibleWidth(l))} ${c.reset}`),
      ];
    }
    if (item.kind === "card") {
      const label = ` ◉ ${this.opts.cardName ?? "your"} · contact card `;
      const pad = Math.max(0, width - visibleWidth(label) - 2);
      const caption = `${item.dryRun ? "would send to" : "to"} ${name(item.handle)}`;
      return [
        `${" ".repeat(Math.max(0, width - visibleWidth(caption) - 2))}${c.dim}${caption}${c.reset}`,
        `${" ".repeat(pad)}${item.dryRun ? `${c.bg(236)}${c.fg(220)}` : `${c.bg(124)}${c.fg(255)}${c.bold}`}${label}${c.reset}`,
      ];
    }
    const lines = wrap(item.text, bubbleMax - 2);
    const w = Math.max(...lines.map(visibleWidth));
    const caption = `${item.dryRun ? "DRY RUN · would send to" : item.fromList ? "reached out to" : "to"} ${name(item.handle)}  ${clock(item.at)}`;
    const color = item.dryRun ? `${c.bg(236)}${c.fg(220)}` : `${c.bg(27)}${c.fg(255)}`;
    const pad = Math.max(0, width - (w + 2) - 2);
    return [
      `${" ".repeat(Math.max(0, width - visibleWidth(caption) - 2))}${c.dim}${caption}${c.reset}`,
      ...lines.map((l) => `${" ".repeat(pad)}${color} ${l}${" ".repeat(w - visibleWidth(l))} ${c.reset}`),
    ];
  }

  private push(item: FeedItem): void {
    this.feed.push(item);
    if (this.feed.length > 300) this.feed.splice(0, this.feed.length - 300);
    this.schedule();
  }

  private readonly onResize = (): void => {
    this.out.write(`${ESC}2J`);
    this.render();
  };

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.render();
    }, 30).unref?.();
  }

  private render(): void {
    const cols = this.out.columns ?? 100;
    const rows = this.out.rows ?? 30;
    const lines = this.lines(cols, rows);
    this.out.write(`${ESC}H${lines.map((l) => `${l}${ESC}K`).join("\r\n")}`);
  }
}
