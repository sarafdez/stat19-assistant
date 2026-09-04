/**
 * Loads the repo-root .env so users can keep their API key and paths in a file instead of
 * exporting them in every shell.
 *
 * Deliberately imports nothing from the app: this module must be the FIRST import in index.ts
 * and must finish before paths.ts reads process.env. Importing paths.ts from here would
 * evaluate it first and silently ignore PORT and STAT19_* overrides set in .env.
 *
 * Values already in the environment win — an exported key overrides the file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");

export const envFileLoaded = (() => {
  if (!fs.existsSync(ENV_PATH)) return false;
  const shell = { ...process.env };
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (err) {
    console.warn(`Kunne ikke lese ${ENV_PATH}: ${(err as Error).message}`);
    return false;
  }
  for (const [key, value] of Object.entries(shell)) {
    if (value) process.env[key] = value;
  }
  return true;
})();
