/**
 * Terminal prompts with no dependencies. Everything here writes to stderr so
 * stdout stays machine-readable, and every function degrades to its default
 * when stdin is not a TTY (CI, a harness piping commands).
 */
import { createInterface } from "node:readline/promises";

const out = (s: string) => process.stderr.write(s);

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function ask(question: string, fallback = ""): Promise<string> {
  if (!interactive()) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = fallback ? ` (${fallback})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  if (!interactive()) return fallback;
  const answer = (await ask(`${question} [${fallback ? "Y/n" : "y/N"}]`)).toLowerCase();
  if (answer === "") return fallback;
  return answer.startsWith("y");
}

/** Read a secret without echoing it. */
export async function askHidden(question: string): Promise<string> {
  if (!interactive()) return "";
  out(`${question}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          out("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          out("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function choose<T>(
  question: string,
  items: T[],
  label: (item: T) => string,
  fallbackIndex = 0,
): Promise<T | undefined> {
  if (items.length === 0) return undefined;
  if (!interactive()) return items[fallbackIndex];
  out(`${question}\n`);
  items.forEach((item, i) => {
    out(`  ${String(i + 1).padStart(2)}. ${label(item)}\n`);
  });
  for (;;) {
    const answer = await ask("Number", String(fallbackIndex + 1));
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    out(`  pick 1–${items.length}\n`);
  }
}

/** A one-line spinner on stderr; call the returned function to stop it. */
export function spinner(text: string): (final?: string) => void {
  if (!process.stderr.isTTY) {
    out(`${text}…\n`);
    return (final) => {
      if (final) out(`${final}\n`);
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  out(`${frames[0]} ${text}`);
  const timer = setInterval(() => {
    i = (i + 1) % frames.length;
    out(`\r${frames[i]} ${text}`);
  }, 80);
  return (final) => {
    clearInterval(timer);
    out(`\r\x1b[2K${final ?? `✓ ${text}`}\n`);
  };
}

export const paint = {
  bold: (s: string) => (process.stderr.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (process.stderr.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (process.stderr.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
};

export function say(line = ""): void {
  out(`${line}\n`);
}
