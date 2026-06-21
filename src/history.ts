import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SnapshotResult {
  ok: boolean;
  message: string;
}

function isGitRepo(dir: string): boolean {
  let current = dir;
  for (let i = 0; i < 50; i++) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * Commits the SQLite file to git for versioned memory history.
 * No-op (with a friendly message) when the DB directory is not a git repo.
 */
export function gitSnapshot(dbPath: string, message?: string): SnapshotResult {
  const dir = dirname(dbPath);
  if (!isGitRepo(dir)) {
    return {
      ok: false,
      message: `Not a git repo: ${dir}. Run \`git init\` there to enable versioned history.`,
    };
  }
  try {
    const file = basename(dbPath);
    execFileSync("git", ["-C", dir, "add", file], { stdio: "pipe" });
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain", file], {
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (status === "") return { ok: true, message: "No changes to snapshot." };
    const msg = message ?? `memory snapshot ${new Date().toISOString()}`;
    execFileSync("git", ["-C", dir, "commit", "-m", msg, file], { stdio: "pipe" });
    return { ok: true, message: `Committed snapshot: ${msg}` };
  } catch (err) {
    return { ok: false, message: `git snapshot failed: ${String(err)}` };
  }
}
