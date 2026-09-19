import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL log of every routing decision. Logging must never break a
 * request, so every failure here is swallowed: a dropped log line is a
 * nuisance; a 500 is a broken session.
 */
export class DecisionLog {
  readonly path: string | null;
  private failed = false;

  constructor(path: string | null) {
    this.path = path;
    if (path === null) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      this.failed = true;
    }
  }

  write(record: Record<string, unknown>): void {
    if (this.path === null || this.failed) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    try {
      appendFileSync(this.path, line, "utf8");
    } catch {
      this.failed = true;
    }
  }
}
