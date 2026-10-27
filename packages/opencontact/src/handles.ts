/**
 * iMessage handles are phone numbers or email addresses. Messages.app reports
 * them in a few spellings; the bridge compares them in one.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailHandle(handle: string): boolean {
  return EMAIL.test(handle.trim());
}

export function isPhoneHandle(handle: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(handle);
}

/**
 * Normalize a handle for comparison and for use as a Bland `end_user_id`.
 *
 * - Emails: trimmed, lower-cased.
 * - Phones: punctuation stripped; a bare 10-digit number is read as US/CA
 *   (`+1`), an 11-digit number starting with 1 gets a `+`. Anything else
 *   already carrying `+` is kept as digits after the `+`.
 * - Anything unrecognized is returned trimmed so it can still be listed
 *   verbatim in a restriction list.
 */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  if (isEmailHandle(trimmed)) return trimmed.toLowerCase();

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;

  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/**
 * The handle this Mac sends from, inferred from recent chats: the most common
 * `last_addressed_handle`, phones preferred over emails. Null when nothing is known.
 */
export function inferOwnHandle(chats: ReadonlyArray<{ last_addressed_handle?: string | undefined }>): string | null {
  const counts = new Map<string, number>();
  for (const c of chats) {
    const h = c.last_addressed_handle ? normalizeHandle(c.last_addressed_handle) : "";
    if (h.length === 0) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.entries()].sort((a, b) => {
    const phoneA = isPhoneHandle(a[0]) ? 1 : 0;
    const phoneB = isPhoneHandle(b[0]) ? 1 : 0;
    return phoneB - phoneA || b[1] - a[1];
  });
  return ranked[0]?.[0] ?? null;
}

/** Mask a handle for logs: keep the last four characters. */
export function maskHandle(handle: string): string {
  if (handle.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, handle.length - 4))}${handle.slice(-4)}`;
}
