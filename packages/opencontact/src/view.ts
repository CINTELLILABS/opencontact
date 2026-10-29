/**
 * The live view for `opencontact run`: every conversation in a sidebar, the
 * selected one as chat bubbles, and a composer so a person can step into any
 * conversation and hand it back to the agent. ANSI only, no dependencies. It
 * owns the screen while it runs (alternate buffer) and gives it back on stop.
 */

export type Driver = "ai" | "you" | "paused";

type ThreadItem =
  | { kind: "in"; text: string; at: Date }
  | { kind: "out"; text: string; at: Date; dryRun: boolean; fromList?: boolean }
  | { kind: "you"; text: string; at: Date }
  | { kind: "card"; at: Date; dryRun: boolean }
  | { kind: "note"; text: string; at: Date };

interface Conversation {
  handle: string;
  items: ThreadItem[];
  lastAt: number;
  unread: number;
  driver: Driver;
}

export interface ViewActions {
  /** Send `text` to `handle` as the owner. Resolves when Messages accepted it. */
  send(handle: string, text: string): Promise<void>;
  /** The owner takes a conversation (true) or hands it back to the agent (false). */
  setManual(handle: string, manual: boolean): void;
  setDryRun(dryRun: boolean): void;
  quit(): void;
}

export interface ViewOptions {
  title: string;
  brain: string;
  answers: string;
  cardName?: string | undefined;
  dryRun: boolean;
  /** Display name for a handle (a saved list name, a contact name, or a formatted number). */
  nameOf: (handle: string) => string;
  actions?: ViewActions | undefined;
  out?: NodeJS.WriteStream;
  now?: () => Date;
}

const ESC = "\x1b[";
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  fg: (n: number) => `${ESC}38;5;${n}m`,
  bg: (n: number) => `${ESC}48;5;${n}m`,
};
const BLUE = 27;
const GRAY = 238;
const GREEN = 28;
const RED = 124;

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

/** Cut a plain string to `width` cells, with an ellipsis when it was longer. */
export function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (visibleWidth(`${out}${ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
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

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

const DOTS = ["●○○", "○●○", "○○●", "○●○"];
const SIDEBAR = 32;

export class LiveView {
  private readonly convos = new Map<string, Conversation>();
  private readonly typing = new Set<string>();
  private readonly out: NodeJS.WriteStream;
  private readonly now: () => Date;
  private dryRun: boolean;
  private selected: string | null = null;
  private follow = true;
  private composing = false;
  private draft = "";
  private status = "watching Messages. Text this number, or run `opencontact text` in another tab.";
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private stats = { in: 0, out: 0, cards: 0 };
  /** Activity order: a counter, so two events in the same millisecond still sort. */
  private seq = 0;

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
      if (this.typing.size > 0 || this.composing) this.render();
    }, 280);
    this.timer.unref?.();
    this.render();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.out.off("resize", this.onResize);
    this.out.write(`${c.reset}${ESC}?25h${ESC}?1049l`);
  }

  // ---- events from the bridge -------------------------------------------

  setDryRun(value: boolean): void {
    this.dryRun = value;
    this.note(
      value ? "dry-run: the agent's replies show here, nothing is sent" : "live: replies go out through Messages",
    );
  }

  inbound(handle: string, text: string): void {
    this.stats.in += 1;
    this.add(handle, { kind: "in", text, at: this.now() });
  }

  thinking(handle: string): void {
    this.typing.add(handle);
    this.touch(handle);
  }

  reply(handle: string, text: string, dryRun: boolean, fromList = false): void {
    this.typing.delete(handle);
    if (!dryRun) this.stats.out += 1;
    this.add(handle, { kind: "out", text, at: this.now(), dryRun, fromList });
  }

  card(handle: string, dryRun: boolean): void {
    if (!dryRun) this.stats.cards += 1;
    this.add(handle, { kind: "card", at: this.now(), dryRun });
  }

  /** The owner wrote in a conversation (from this view or from Messages). */
  you(handle: string, text: string): void {
    this.add(handle, { kind: "you", text, at: this.now() });
  }

  /** Who is driving a conversation now. */
  driver(handle: string, driver: Driver): void {
    const convo = this.ensure(handle);
    convo.driver = driver;
    this.schedule();
  }

  done(handle: string): void {
    this.typing.delete(handle);
    this.schedule();
  }

  note(text: string, _tone: "dim" | "warn" | "error" = "dim"): void {
    this.status = text;
    this.schedule();
  }

  // ---- keys ----------------------------------------------------------------

  /** Feed raw stdin data. Returns true when the view handled it. */
  key(data: string): boolean {
    if (this.composing) return this.composeKey(data);
    const list = this.ordered();
    const idx = this.selected ? list.findIndex((h) => h === this.selected) : -1;
    switch (data) {
      case "\x1b[A":
      case "k":
        if (list.length > 0) this.select(list[Math.max(0, idx - 1)] ?? list[0] ?? null, false);
        return true;
      case "\x1b[B":
      case "j":
      case "\t":
        if (list.length > 0) this.select(list[Math.min(list.length - 1, idx + 1)] ?? null, false);
        return true;
      case "\r":
      case "\n":
      case "i":
        if (this.selected) {
          this.composing = true;
          this.draft = "";
          this.out.write(`${ESC}?25h`);
          this.schedule();
        } else this.note("no conversation selected yet");
        return true;
      case "a":
      case "A":
        if (this.selected) {
          const convo = this.ensure(this.selected);
          const toAi = convo.driver !== "ai";
          this.opts.actions?.setManual(this.selected, !toAi);
          convo.driver = toAi ? "ai" : "you";
          this.note(
            toAi
              ? `${this.opts.nameOf(this.selected)}: back to the agent`
              : `${this.opts.nameOf(this.selected)}: you have this one; the agent stays out`,
          );
        }
        return true;
      case "f":
      case "F":
        this.follow = !this.follow;
        if (this.follow) this.select(list[0] ?? null, true);
        this.note(this.follow ? "following the latest conversation" : "follow off");
        return true;
      case "l":
      case "L":
        this.opts.actions?.setDryRun(false);
        return true;
      case "d":
      case "D":
        this.opts.actions?.setDryRun(true);
        return true;
      case "q":
      case "Q":
      case "\u0003":
        this.opts.actions?.quit();
        return true;
      default:
        return false;
    }
  }

  private composeKey(data: string): boolean {
    if (data === "\u0003") {
      this.opts.actions?.quit();
      return true;
    }
    if (data === "\x1b") {
      this.composing = false;
      this.draft = "";
      this.out.write(`${ESC}?25l`);
      this.schedule();
      return true;
    }
    if (data === "\r" || data === "\n") {
      const text = this.draft.trim();
      const handle = this.selected;
      this.composing = false;
      this.draft = "";
      this.out.write(`${ESC}?25l`);
      if (text && handle) {
        const convo = this.ensure(handle);
        convo.driver = "you";
        this.opts.actions?.setManual(handle, true);
        this.you(handle, text);
        this.opts.actions?.send(handle, text).catch((err: unknown) => {
          this.note(`could not send to ${this.opts.nameOf(handle)}: ${(err as Error).message}`, "error");
        });
      }
      this.schedule();
      return true;
    }
    if (data === "\x7f" || data === "\b") {
      this.draft = [...this.draft].slice(0, -1).join("");
      this.schedule();
      return true;
    }
    // Ignore other escape sequences (arrows) while typing; take printable text, including pastes.
    if (data.startsWith("\x1b")) return true;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from typed text
    this.draft += data.replace(/[\x00-\x1f]/g, "");
    this.schedule();
    return true;
  }

  // ---- layout --------------------------------------------------------------

  /** The lines of the screen, without writing them. Public for tests. */
  lines(cols: number, rows: number): string[] {
    const width = Math.max(60, cols);
    const side = Math.min(SIDEBAR, Math.floor(width * 0.34));
    const main = width - side - 1;
    const header = this.header(width);
    const footer = this.footer(width);
    const bodyRows = Math.max(3, rows - header.length - footer.length);

    const sideLines = this.sidebar(side, bodyRows);
    const mainLines = this.thread(main, bodyRows);
    const body: string[] = [];
    for (let i = 0; i < bodyRows; i++) {
      body.push(`${pad(sideLines[i] ?? "", side)}${c.fg(237)}│${c.reset}${mainLines[i] ?? ""}`);
    }
    return [...header, ...body, ...footer];
  }

  private header(width: number): string[] {
    const mode = this.dryRun ? `${c.fg(220)}${c.bold}● DRY RUN` : `${c.fg(46)}${c.bold}● LIVE`;
    const left = ` ${c.bold}${this.opts.title}${c.reset}${c.bg(236)}${c.fg(250)}  ·  ${this.opts.brain}  ·  answers ${this.opts.answers}`;
    const right = `${mode}${c.reset}${c.bg(236)} `;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [`${c.bg(236)}${c.fg(255)}${left}${" ".repeat(gap)}${right}${c.reset}`];
  }

  private sidebar(width: number, rows: number): string[] {
    const list = this.ordered();
    const lines: string[] = [];
    const title = `${c.dim} CONVERSATIONS${c.reset}`;
    const followTag = this.follow ? `${c.fg(39)}following${c.reset} ` : "";
    lines.push(`${title}${" ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(followTag)))}${followTag}`);
    lines.push("");
    if (list.length === 0) {
      lines.push(`${c.dim} no conversations yet${c.reset}`);
      return lines;
    }
    for (const handle of list) {
      if (lines.length + 3 > rows) break;
      const convo = this.convos.get(handle) as Conversation;
      const selected = handle === this.selected;
      const typing = this.typing.has(handle);
      const badge = typing
        ? `${c.fg(39)}${DOTS[this.frame % DOTS.length]}`
        : convo.driver === "ai"
          ? `${c.fg(46)}AI`
          : `${c.fg(214)}YOU`;
      const unread = convo.unread > 0 && !selected ? `${c.fg(39)}● ` : "  ";
      const name = truncate(this.opts.nameOf(handle), width - 10);
      const last = convo.items.at(-1);
      const preview = last
        ? last.kind === "card"
          ? "contact card"
          : last.kind === "note"
            ? last.text
            : `${last.kind === "in" ? "" : last.kind === "you" ? "you: " : "agent: "}${last.text}`
        : "";
      const bg = selected ? c.bg(237) : "";
      const bar = selected ? `${c.fg(33)}▌${c.reset}${bg}` : " ";
      const top = `${bar}${unread}${c.reset}${bg}${selected ? c.bold : ""}${c.fg(255)}${name}${c.reset}${bg}`;
      const topLine = `${top}${" ".repeat(Math.max(1, width - visibleWidth(top) - visibleWidth(badge) - 1))}${badge}${c.reset}${bg} ${c.reset}`;
      const previewColor = selected ? c.fg(250) : c.dim;
      const prev = `${bar}  ${c.reset}${bg}${previewColor}${truncate(preview.replace(/\s+/g, " "), width - 4)}${c.reset}`;
      lines.push(selected ? pad(topLine, width) : topLine, selected ? `${pad(prev, width - 1)}${bg} ${c.reset}` : prev);
      lines.push("");
    }
    return lines;
  }

  private thread(width: number, rows: number): string[] {
    const handle = this.selected;
    if (!handle) {
      const msg = "Waiting for the first conversation.";
      return [
        ...Array.from({ length: Math.floor(rows / 2) - 1 }, () => ""),
        `${" ".repeat(Math.max(0, Math.floor((width - msg.length) / 2)))}${c.dim}${msg}${c.reset}`,
      ];
    }
    const convo = this.ensure(handle);
    const driver =
      convo.driver === "ai" ? `${c.fg(46)}● agent is answering` : `${c.fg(214)}● you have this conversation`;
    const titleLine = ` ${c.bold}${this.opts.nameOf(handle)}${c.reset}  ${c.dim}${formatHandle(handle)}${c.reset}`;
    const head = [
      `${titleLine}${" ".repeat(Math.max(1, width - visibleWidth(titleLine) - visibleWidth(driver) - 1))}${driver}${c.reset}`,
      "",
    ];

    const bubbleMax = Math.max(20, Math.min(56, Math.floor(width * 0.7)));
    const body: string[] = [];
    for (const item of convo.items) {
      if (body.length > 0) body.push("");
      body.push(...this.renderItem(item, width - 1, bubbleMax));
    }
    if (this.typing.has(handle)) {
      body.push(
        "",
        `${" ".repeat(Math.max(0, width - 9))}${c.bg(BLUE)}${c.fg(255)} ${DOTS[this.frame % DOTS.length]} ${c.reset}`,
      );
    }
    const room = rows - head.length;
    const visible = body.slice(-room);
    while (visible.length < room) visible.unshift("");
    return [...head, ...visible];
  }

  private renderItem(item: ThreadItem, width: number, bubbleMax: number): string[] {
    if (item.kind === "note") {
      const pad0 = Math.max(0, Math.floor((width - visibleWidth(item.text)) / 2));
      return [`${" ".repeat(pad0)}${c.dim}${item.text}${c.reset}`];
    }
    if (item.kind === "in") {
      const lines = wrap(item.text, bubbleMax - 2);
      const w = Math.max(...lines.map(visibleWidth));
      return [
        `  ${c.dim}${clock(item.at)}${c.reset}`,
        ...lines.map((l) => `  ${c.bg(GRAY)}${c.fg(255)} ${l}${" ".repeat(w - visibleWidth(l))} ${c.reset}`),
      ];
    }
    if (item.kind === "card") {
      const label = ` ◉ ${this.opts.cardName ?? "your"} · contact card `;
      const caption = item.dryRun ? "would send" : "sent";
      return [
        `${" ".repeat(Math.max(0, width - visibleWidth(caption)))}${c.dim}${caption}${c.reset}`,
        `${" ".repeat(Math.max(0, width - visibleWidth(label)))}${item.dryRun ? `${c.bg(236)}${c.fg(220)}` : `${c.bg(RED)}${c.fg(255)}${c.bold}`}${label}${c.reset}`,
      ];
    }
    const lines = wrap(item.text, bubbleMax - 2);
    const w = Math.max(...lines.map(visibleWidth));
    const who =
      item.kind === "you"
        ? "you"
        : item.dryRun
          ? "agent · DRY RUN, not sent"
          : item.fromList
            ? "agent · reached out"
            : "agent";
    const caption = `${who}  ${clock(item.at)}`;
    const color =
      item.kind === "you"
        ? `${c.bg(GREEN)}${c.fg(255)}`
        : item.dryRun
          ? `${c.bg(236)}${c.fg(220)}`
          : `${c.bg(BLUE)}${c.fg(255)}`;
    const left = Math.max(0, width - (w + 2));
    return [
      `${" ".repeat(Math.max(0, width - visibleWidth(caption)))}${c.dim}${caption}${c.reset}`,
      ...lines.map((l) => `${" ".repeat(left)}${color} ${l}${" ".repeat(w - visibleWidth(l))} ${c.reset}`),
    ];
  }

  private footer(width: number): string[] {
    const sep = `${c.fg(237)}${"─".repeat(width)}${c.reset}`;
    if (this.composing && this.selected) {
      const label = ` to ${this.opts.nameOf(this.selected)} › `;
      const room = width - visibleWidth(label) - 2;
      const shown = visibleWidth(this.draft) > room ? `…${[...this.draft].slice(-(room - 1)).join("")}` : this.draft;
      const cursor = this.frame % 2 === 0 ? "▏" : " ";
      return [
        sep,
        `${c.fg(46)}${c.bold}${label}${c.reset}${shown}${cursor}`,
        `${c.dim} Enter send as you (the agent pauses in this conversation)  ·  Esc cancel${c.reset}`,
      ];
    }
    const stats = `${this.stats.in} in · ${this.stats.out} sent · ${this.stats.cards} ${this.stats.cards === 1 ? "card" : "cards"}`;
    const status = ` ${c.dim}${truncate(this.status, Math.max(10, width - visibleWidth(stats) - 4))}${c.reset}`;
    const keys = `${c.dim} ↑↓ switch  ·  Enter write as you  ·  A agent on/off  ·  F follow  ·  L live  D dry-run  ·  Q quit${c.reset}`;
    return [
      sep,
      `${status}${" ".repeat(Math.max(1, width - visibleWidth(status) - visibleWidth(stats) - 1))}${c.dim}${stats}${c.reset}`,
      keys,
    ];
  }

  // ---- state ---------------------------------------------------------------

  private ensure(handle: string): Conversation {
    let convo = this.convos.get(handle);
    if (!convo) {
      convo = { handle, items: [], lastAt: ++this.seq, unread: 0, driver: "ai" };
      this.convos.set(handle, convo);
    }
    return convo;
  }

  private add(handle: string, item: ThreadItem): void {
    const convo = this.ensure(handle);
    convo.items.push(item);
    if (convo.items.length > 200) convo.items.splice(0, convo.items.length - 200);
    if (handle !== this.selected) convo.unread += 1;
    this.touch(handle);
  }

  private touch(handle: string): void {
    const convo = this.ensure(handle);
    convo.lastAt = ++this.seq;
    if (this.follow && !this.composing) this.select(handle, true);
    else if (!this.selected) this.select(handle, true);
    this.schedule();
  }

  private select(handle: string | null, keepFollow: boolean): void {
    if (!keepFollow) this.follow = false;
    this.selected = handle;
    if (handle) this.ensure(handle).unread = 0;
    this.schedule();
  }

  /** Most recent activity first. */
  private ordered(): string[] {
    return [...this.convos.values()].sort((a, b) => b.lastAt - a.lastAt).map((v) => v.handle);
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
