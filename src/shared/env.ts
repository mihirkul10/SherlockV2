import { config as loadDotenv } from "dotenv";
import { ENV_PATH } from "./paths.js";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loadDotenv({ path: ENV_PATH });
  loaded = true;
}

export function requireEnv(key: string, hint?: string): string {
  loadEnv();
  const value = process.env[key];
  if (!value) {
    const suffix = hint ? ` (${hint})` : "";
    throw new Error(`Missing required env var: ${key}${suffix}. Add it to ${ENV_PATH}`);
  }
  return value;
}

export function optionalEnv(key: string): string | undefined {
  loadEnv();
  return process.env[key];
}
