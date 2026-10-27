import { readFileSync } from "node:fs";
import { extname } from "node:path";

/**
 * The business's contact card, sent once per customer so "Add to Contacts"
 * shows the business name and logo instead of a bare number. This is the
 * literal "contacts in your phone".
 */
export interface ContactCard {
  /** Display name, usually the business name. */
  name: string;
  /** The number or email customers text. Optional: Messages already shows the sender. */
  phone?: string | undefined;
  email?: string | undefined;
  url?: string | undefined;
  /** Path to a JPEG or PNG logo on disk. */
  photoPath?: string | undefined;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, ";");
}

/** vCard 3.0, which Messages.app renders as a tappable contact. */
export function buildVCard(card: ContactCard, readFile: (path: string) => Buffer = (p) => readFileSync(p)): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  const name = card.name.trim();
  lines.push(`N:;${escapeText(name)};;;`);
  lines.push(`FN:${escapeText(name)}`);
  lines.push(`ORG:${escapeText(name)}`);
  if (card.phone) lines.push(`TEL;TYPE=CELL,VOICE:${card.phone.trim()}`);
  if (card.email) lines.push(`EMAIL;TYPE=INTERNET:${card.email.trim()}`);
  if (card.url) lines.push(`URL:${card.url.trim()}`);
  if (card.photoPath) {
    const ext = extname(card.photoPath).toLowerCase();
    const type = ext === ".png" ? "PNG" : ext === ".jpg" || ext === ".jpeg" ? "JPEG" : null;
    if (type) {
      const b64 = readFile(card.photoPath).toString("base64");
      // Fold at 75 octets per RFC 2425 so strict parsers accept it.
      const folded = `PHOTO;ENCODING=b;TYPE=${type}:${b64}`.match(/.{1,75}/g) ?? [];
      lines.push(folded.join("\r\n "));
    }
  }
  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}
