import { isEmailHandle, isPhoneHandle, normalizeHandle } from "./handles.ts";

export interface Recipient {
  handle: string;
  name?: string | undefined;
  /** Any other columns, passed to the agent as details. */
  details: Record<string, string>;
}

/** Split one CSV line, honoring double quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const PHONE_HEADERS = ["phone", "number", "phone_number", "mobile", "cell", "to", "handle", "email"];
const NAME_HEADERS = ["name", "first_name", "firstname", "first", "full_name"];

/**
 * Recipients from a CSV or a plain list (one number per line). A header row is
 * detected when its first cell is not a number or email. Rows without a usable
 * phone or email are reported in `skipped`; duplicates keep the first row.
 */
export function parseRecipients(text: string): { recipients: Recipient[]; skipped: string[] } {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map(splitCsvLine);
  if (rows.length === 0) return { recipients: [], skipped: [] };

  const first = rows[0] as string[];
  const looksLikeHandle = (v: string) => {
    const n = normalizeHandle(v);
    return isPhoneHandle(n) || isEmailHandle(n);
  };
  const hasHeader = !looksLikeHandle(first[0] ?? "");
  const header = hasHeader ? first.map((h) => h.toLowerCase().replace(/\s+/g, "_")) : [];
  const body = hasHeader ? rows.slice(1) : rows;

  let phoneCol = hasHeader ? header.findIndex((h) => PHONE_HEADERS.includes(h)) : 0;
  if (phoneCol < 0) phoneCol = 0;
  let nameCol = hasHeader ? header.findIndex((h) => NAME_HEADERS.includes(h)) : 1;
  if (nameCol === phoneCol) nameCol = -1;

  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const skipped: string[] = [];
  for (const row of body) {
    const raw = row[phoneCol] ?? "";
    const handle = normalizeHandle(raw);
    if (!isPhoneHandle(handle) && !isEmailHandle(handle)) {
      skipped.push(row.join(","));
      continue;
    }
    if (seen.has(handle)) continue;
    seen.add(handle);
    const name = nameCol >= 0 ? row[nameCol] || undefined : undefined;
    const details: Record<string, string> = {};
    row.forEach((v, i) => {
      if (i === phoneCol || i === nameCol || !v) return;
      details[hasHeader ? (header[i] ?? `field${i + 1}`) : `field${i + 1}`] = v;
    });
    recipients.push({ handle, name, details });
  }
  return { recipients, skipped };
}

/** The context the agent gets for one recipient of a list send. */
export function recipientContext(why: string | undefined, r: Recipient): string {
  const parts: string[] = [];
  if (why) parts.push(why);
  if (r.name) parts.push(`The recipient's name is ${r.name}.`);
  const details = Object.entries(r.details).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  if (details.length > 0) parts.push(`Details for this recipient: ${details.join("; ")}.`);
  return parts.join(" ");
}
