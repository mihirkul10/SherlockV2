import { search, getStats } from "../src/index/sqlite-fts.js";
import { loadEnv } from "../src/shared/env.js";
loadEnv();
console.log("stats:", getStats());
for (const q of ["Stripe Sessions 2026", "Stripe Sessions", "stripe", "stripe sessions keynote highlights", "what did Stripe show at Stripe Sessions 2026"]) {
  const hits = search(q, {}, 3);
  console.log(`\nquery: "${q}" → ${hits.length} hits`);
  for (const h of hits) console.log(`  rank=${h.rank.toFixed(2)} | ${h.title}`);
}
