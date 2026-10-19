import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Load the nearest `.env` by walking up from cwd. Lets workspace scripts
 * (which run with cwd = the package dir) find the repo-root `.env`.
 * Uses Node 20.12+ native env loading — no dotenv dependency.
 */
export function loadEnv(): void {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return; // reached fs root, no .env found
    dir = parent;
  }
}
