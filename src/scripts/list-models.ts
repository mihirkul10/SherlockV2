/**
 * List the model catalog the current CURSOR_API_KEY has access to.
 *
 * Used to pick exact model IDs for Sherlock-Front and Sherlock-Researcher.
 *
 * Usage: npx tsx src/scripts/list-models.ts
 */

import { Cursor } from "@cursor/sdk";
import { loadEnv, requireEnv } from "../shared/env.js";

async function main(): Promise<void> {
  loadEnv();
  const apiKey = requireEnv("CURSOR_API_KEY");
  const models = await Cursor.models.list({ apiKey });

  for (const m of models) {
    const variants = (m as unknown as { variants?: Array<{ displayName?: string }> }).variants;
    const variantSummary = variants && variants.length > 0
      ? ` (${variants.length} variants: ${variants.map((v) => v.displayName).filter(Boolean).join(", ")})`
      : "";
    console.log(`${m.id.padEnd(50)} ${(m as unknown as { displayName?: string }).displayName ?? ""}${variantSummary}`);
  }

  console.log(`\n${models.length} models total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
