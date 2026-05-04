import { search, getStats } from "../src/index/sqlite-fts.js";
import { loadEnv } from "../src/shared/env.js";
loadEnv();
console.log("stats:", getStats());
console.log("\n--- query 1: 'stripe sessions keynote' ---");
for (const h of search("stripe sessions keynote", {}, 3)) {
  console.log(`  rank=${h.rank.toFixed(2)} | ${h.title}`);
  console.log(`    ${h.snippet.slice(0, 200)}`);
}
console.log("\n--- query 2: 'AI agents' (filter sources=youtube) ---");
for (const h of search("AI agents", { sources: ["youtube"] }, 3)) {
  console.log(`  rank=${h.rank.toFixed(2)} | ${h.author} - ${h.title}`);
  console.log(`    ${h.snippet.slice(0, 200)}`);
}
console.log("\n--- query 3: 'Sam Altman' ---");
for (const h of search("sam altman", {}, 3)) {
  console.log(`  rank=${h.rank.toFixed(2)} | ${h.title}`);
  console.log(`    ${h.snippet.slice(0, 200)}`);
}
