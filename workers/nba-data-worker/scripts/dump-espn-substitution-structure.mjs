#!/usr/bin/env node
/**
 * One-off: fetch ESPN game summary and print raw JSON of substitution plays
 * so we can see exact structure for player_in_id / player_out_id.
 *
 * Usage: node scripts/dump-espn-substitution-structure.mjs [gameId]
 * Example: node scripts/dump-espn-substitution-structure.mjs 401810603
 */

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const gameId = process.argv[2] || "401810603";

function extractPlays(summary) {
  if (Array.isArray(summary?.plays)) return summary.plays;
  const headerComp = summary?.header;
  const compArr = headerComp?.competitions;
  let comps = Array.isArray(compArr) && compArr.length > 0 ? compArr[0] : null;
  if (!comps) {
    const rootComps = summary?.competitions;
    comps = Array.isArray(rootComps) && rootComps.length > 0 ? rootComps[0] : null;
  }
  if (comps?.plays) return comps.plays;
  if (summary?.gamecast?.plays) return summary.gamecast.plays;
  if (summary?.boxscore?.plays) return summary.boxscore.plays;
  return [];
}

function isSubstitution(play) {
  const sub = play?.substitution;
  const typeObj = play?.type;
  const typeText = String(typeObj?.text ?? play?.typeText ?? "").toLowerCase();
  const typeId = String(typeObj?.id ?? play?.typeId ?? "");
  return !!sub || typeText.includes("substitution") || typeId === "12";
}

async function main() {
  const url = `${ESPN_BASE}/summary?event=${gameId}`;
  console.error("Fetching:", url);
  const res = await fetch(url);
  if (!res.ok) {
    console.error("HTTP", res.status, res.statusText);
    process.exit(1);
  }
  const summary = await res.json();
  const plays = extractPlays(summary);
  console.error("Total plays:", plays?.length ?? 0);

  const subs = (plays || []).filter(isSubstitution);
  console.error("Substitution plays:", subs.length);

  if (subs.length === 0) {
    console.log("No substitution plays found. Sample of first 2 plays (any type):");
    (plays || []).slice(0, 2).forEach((p, i) => console.log(JSON.stringify(p, null, 2)));
    return;
  }

  console.log("\n--- Raw JSON of first 5 substitution plays ---\n");
  subs.slice(0, 5).forEach((play, i) => {
    console.log(`\n========== Substitution #${i + 1} ==========`);
    console.log(JSON.stringify(play, null, 2));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
