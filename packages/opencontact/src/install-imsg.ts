/**
 * Install imsg without a compiler: fetch the signed macOS release build,
 * verify it against the published SHA256SUMS and the author's Developer ID,
 * and unpack it under ~/.local/share/opencontact/imsg.
 *
 * Homebrew's formula builds imsg from Swift source, which fails on Macs with
 * old Command Line Tools. The release zip is what the project itself signs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IMSG_RELEASE_BASE = "https://github.com/openclaw/imsg/releases/latest/download";
/** Developer ID team of imsg's author (Peter Steinberger). Refuse anything else. */
export const IMSG_TEAM_ID = "Y5PE65HELJ";
export const IMSG_INSTALL_DIR = join(homedir(), ".local", "share", "opencontact", "imsg");

/** Parse `SHA256SUMS` (`<hex>  <filename>` per line) into a filename → hash map. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out.set((m[2] as string).trim(), (m[1] as string).toLowerCase());
  }
  return out;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface InstallResult {
  path: string;
  version: string;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download, verify, unpack, and return the path of the imsg binary.
 * Throws with a plain-language reason on any verification failure.
 */
export async function installImsgFromRelease(
  opts: { dir?: string; fetch?: typeof fetch; report?: (step: string) => void } = {},
): Promise<InstallResult> {
  if (process.platform !== "darwin") throw new Error("the imsg release build is macOS only");
  const dir = opts.dir ?? IMSG_INSTALL_DIR;
  const fetchImpl = opts.fetch ?? fetch;
  const report = opts.report ?? (() => {});

  report("downloading imsg-macos.zip");
  const [zip, sums] = await Promise.all([
    download(`${IMSG_RELEASE_BASE}/imsg-macos.zip`, fetchImpl),
    download(`${IMSG_RELEASE_BASE}/SHA256SUMS`, fetchImpl),
  ]);

  report("verifying checksum");
  const expected = parseSha256Sums(sums.toString("utf8")).get("imsg-macos.zip");
  if (!expected) throw new Error("SHA256SUMS does not list imsg-macos.zip");
  const actual = sha256(zip);
  if (actual !== expected)
    throw new Error(`checksum mismatch for imsg-macos.zip (expected ${expected}, got ${actual})`);

  report("unpacking");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const zipPath = join(dir, "imsg-macos.zip");
  writeFileSync(zipPath, zip);
  // ditto is part of macOS and preserves the code-signature resource forks.
  const unzip = spawnSync("ditto", ["-x", "-k", zipPath, dir], { encoding: "utf8" });
  if (unzip.status !== 0) throw new Error(`could not unpack imsg: ${unzip.stderr.trim()}`);
  rmSync(zipPath, { force: true });
  const bin = join(dir, "imsg");
  if (!existsSync(bin)) throw new Error("the release zip did not contain an imsg binary");
  chmodSync(bin, 0o755);

  report("checking code signature");
  const sig = spawnSync("codesign", ["-dv", "--verbose=2", bin], { encoding: "utf8" });
  const details = `${sig.stdout}\n${sig.stderr}`;
  if (sig.status !== 0 || !details.includes(`TeamIdentifier=${IMSG_TEAM_ID}`)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`imsg is not signed by the expected developer (team ${IMSG_TEAM_ID}); refusing to install it`);
  }
  // The download carries a quarantine flag; the signature check above is what we trust instead.
  spawnSync("xattr", ["-dr", "com.apple.quarantine", dir], { stdio: "ignore" });

  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error(`imsg installed but does not run: ${version.stderr.trim()}`);
  return { path: bin, version: version.stdout.trim() };
}

/** Read the installed version, if the release build is already there. */
export function installedReleaseImsg(dir: string = IMSG_INSTALL_DIR): string | null {
  const bin = join(dir, "imsg");
  if (!existsSync(bin)) return null;
  try {
    readFileSync(bin, { flag: "r" }).byteLength;
    return bin;
  } catch {
    return null;
  }
}
