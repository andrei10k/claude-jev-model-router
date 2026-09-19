import { readFileSync } from "node:fs";

/**
 * Minimal .env loader: KEY=VALUE lines, `#` comments, optional quotes.
 * Variables already set in the real environment win, so an exported value can
 * still override the file. Returns the path loaded, or null when none existed.
 */
export function loadDotEnv(paths: readonly string[]): string | null {
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (key in process.env) continue;
      process.env[key] = value;
    }
    return path;
  }
  return null;
}
