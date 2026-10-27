#!/usr/bin/env node
// Lint for skills/*/SKILL.md: frontmatter with a valid `name` that matches the
// directory and a non-empty `description`, body under 300 lines, no secrets.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../skills/", import.meta.url).pathname;
const problems = [];
let count = 0;

for (const dir of readdirSync(root)) {
  const path = join(root, dir);
  if (!statSync(path).isDirectory()) continue;
  const file = join(path, "SKILL.md");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    problems.push(`${dir}: missing SKILL.md`);
    continue;
  }
  count += 1;
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    problems.push(`${dir}: SKILL.md has no YAML frontmatter`);
    continue;
  }
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  // Accept `description: text` and YAML folded blocks (`description: >` + indented lines).
  const descMatch = fm.match(/^description:[ \t]*([>|]?)[ \t]*(.*)$((?:\n[ \t]+.*)*)/m);
  const desc = descMatch ? `${descMatch[2] ?? ""} ${descMatch[3] ?? ""}`.replace(/\s+/g, " ").trim() : undefined;
  if (!name) problems.push(`${dir}: frontmatter needs \`name\``);
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
    problems.push(`${dir}: name "${name}" must be lowercase with hyphens`);
  else if (name !== dir) problems.push(`${dir}: name "${name}" must match the directory`);
  if (!desc || desc.length < 20) problems.push(`${dir}: frontmatter needs a \`description\` (20+ chars)`);
  const lines = text.split("\n").length;
  if (lines > 300) problems.push(`${dir}: SKILL.md is ${lines} lines; keep skills under 300`);
  if (/(sk|org)-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,}/.test(text))
    problems.push(`${dir}: looks like it contains a real credential`);
}

if (count === 0) problems.push("no skills found under skills/");
if (problems.length > 0) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${count} skill(s) OK`);
