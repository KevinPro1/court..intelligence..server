#!/usr/bin/env node
/**
 * Fetch ESPN summary for a game, derive current lineup (starters + all subs),
 * and compare with our game_lineup_current (passed as args or hardcoded).
 *
 * Usage: node scripts/compare-lineup-with-espn.mjs <gameId> [homeIds] [awayIds]
 * Example: node scripts/compare-lineup-with-espn.mjs 401810604 '5061568,5037871,4845367,4395630,3064560' '5041939,6475,3135046,4277848,4278078'
 */

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const MAX_ON_COURT = 5;

function extractPlays(summary) {
  if (Array.isArray(summary?.plays)) return summary.plays;
  const comps = summary?.header?.competitions?.[0] || summary?.competitions?.[0];
  if (comps?.plays) return comps.plays;
  if (summary?.gamecast?.plays) return summary.gamecast.plays;
  if (summary?.boxscore?.plays) return summary.boxscore.plays;
  return [];
}

function parseBoxscorePlayers(summary) {
  const out = [];
  const root = summary || {};
  let box = root.boxscore ?? root;
  if (!Array.isArray(box?.teams) && !Array.isArray(box?.players)) {
    const comp0 = root?.header?.competitions?.[0];
    if (comp0?.boxscore) box = comp0.boxscore;
  }
  const teamsOrPlayers = box?.players ?? box?.teams ?? [];
  for (const t of teamsOrPlayers) {
    const teamId = t?.team?.id ?? t?.id ?? t?.teamId;
    const stat0 = Array.isArray(t?.statistics) ? t.statistics[0] : null;
    const athletes = stat0?.athletes ?? t?.statistics ?? t?.players ?? [];
    for (const p of athletes) {
      const athlete = p?.athlete ?? p;
      const playerId = String(athlete?.id ?? p?.id ?? "").trim();
      if (!playerId) continue;
      const isStarter = !!(p?.starter ?? (p?.order != null && p?.order <= 5));
      out.push({ playerId, teamId: String(teamId || ""), isStarter });
    }
  }
  return out;
}

function getStarters(boxscorePlayers, homeTeamId, awayTeamId) {
  const home = [];
  const away = [];
  const h = String(homeTeamId || "");
  const a = String(awayTeamId || "");
  for (const p of boxscorePlayers) {
    if (!p.isStarter) continue;
    const tid = String(p.teamId || "");
    if (tid === h) home.push(p.playerId);
    else if (tid === a) away.push(p.playerId);
  }
  return { homeTeamId: h, awayTeamId: a, homeStarters: home, awayStarters: away };
}

function trimFromFront(arr, set, maxLen, justAddedId) {
  while (arr.length > maxLen) {
    const idx = arr.findIndex((id) => id !== justAddedId);
    if (idx === -1) break;
    const removed = arr[idx];
    set.delete(removed);
    arr.splice(idx, 1);
  }
}

function deriveFromESPN(summary, homeTeamId, awayTeamId) {
  const boxscorePlayers = parseBoxscorePlayers(summary);
  const starters = getStarters(boxscorePlayers, homeTeamId, awayTeamId);
  let homeArr = starters.homeStarters.slice(0, MAX_ON_COURT);
  let awayArr = starters.awayStarters.slice(0, MAX_ON_COURT);
  const homeSet = new Set(homeArr);
  const awaySet = new Set(awayArr);

  const plays = extractPlays(summary);
  const subs = plays
    .filter(
      (p) =>
        (p.type?.text || "").toLowerCase().includes("substitution") || p.type?.id === "584"
    )
    .map((p) => {
      const parts = p.participants || [];
      const playerIn = parts[0]?.athlete?.id ? String(parts[0].athlete.id) : null;
      const playerOut = parts[1]?.athlete?.id ? String(parts[1].athlete.id) : null;
      return {
        seq: Number(p.sequenceNumber) || 0,
        teamId: p.team?.id != null ? String(p.team.id) : null,
        playerInId: playerIn,
        playerOutId: playerOut,
      };
    })
    .filter((s) => s.playerInId || s.playerOutId)
    .sort((a, b) => a.seq - b.seq);

  for (const sub of subs) {
    const isHome = sub.teamId === starters.homeTeamId;
    const isAway = sub.teamId === starters.awayTeamId;

    if (sub.playerOutId) {
      if (isHome && homeSet.has(sub.playerOutId)) {
        homeSet.delete(sub.playerOutId);
        homeArr = homeArr.filter((id) => id !== sub.playerOutId);
      } else if (isAway && awaySet.has(sub.playerOutId)) {
        awaySet.delete(sub.playerOutId);
        awayArr = awayArr.filter((id) => id !== sub.playerOutId);
      }
    }
    if (sub.playerInId) {
      if (homeSet.has(sub.playerInId) || awaySet.has(sub.playerInId)) continue;
      if (isHome) {
        homeArr.push(sub.playerInId);
        homeSet.add(sub.playerInId);
        trimFromFront(homeArr, homeSet, MAX_ON_COURT, sub.playerInId);
      } else if (isAway) {
        awayArr.push(sub.playerInId);
        awaySet.add(sub.playerInId);
        trimFromFront(awayArr, awaySet, MAX_ON_COURT, sub.playerInId);
      }
    }
  }

  return {
    home: homeArr.slice(0, MAX_ON_COURT),
    away: awayArr.slice(0, MAX_ON_COURT),
  };
}

async function main() {
  const gameId = process.argv[2] || "401810604";
  const ourHome = (process.argv[3] || "5061568,5037871,4845367,4395630,3064560").split(",").map((s) => s.trim()).filter(Boolean);
  const ourAway = (process.argv[4] || "5041939,6475,3135046,4277848,4278078").split(",").map((s) => s.trim()).filter(Boolean);

  const url = `${ESPN_BASE}/summary?event=${gameId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const summary = await res.json();

  const competitors = summary?.header?.competitions?.[0]?.competitors || summary?.competitions?.[0]?.competitors || [];
  let homeTeamId = null;
  let awayTeamId = null;
  for (const c of competitors) {
    const id = c?.id ?? c?.team?.id;
    if (c?.homeAway === "home") homeTeamId = String(id);
    if (c?.homeAway === "away") awayTeamId = String(id);
  }
  if (!homeTeamId && competitors[0]) homeTeamId = String(competitors[0].id ?? competitors[0].team?.id);
  if (!awayTeamId && competitors[1]) awayTeamId = String(competitors[1].id ?? competitors[1].team?.id);

  const espn = deriveFromESPN(summary, homeTeamId, awayTeamId);

  const sortIds = (a) => [...a].sort();
  const homeMatch = sortIds(ourHome).join(",") === sortIds(espn.home).join(",");
  const awayMatch = sortIds(ourAway).join(",") === sortIds(espn.away).join(",");

  console.log("Game:", gameId);
  console.log("Home (SAS) teamId:", homeTeamId, "| Away (DAL) teamId:", awayTeamId);
  console.log("");
  console.log("ESPN derived (from summary starters + all subs):");
  console.log("  home:", espn.home);
  console.log("  away:", espn.away);
  console.log("");
  console.log("Our game_lineup_current:");
  console.log("  home:", ourHome);
  console.log("  away:", ourAway);
  console.log("");
  console.log("Match home (SAS):", homeMatch ? "YES" : "NO");
  console.log("Match away (DAL):", awayMatch ? "YES" : "NO");
  if (!homeMatch) {
    const onlyUs = ourHome.filter((id) => !espn.home.includes(id));
    const onlyEspn = espn.home.filter((id) => !ourHome.includes(id));
    if (onlyUs.length) console.log("  Only in ours (home):", onlyUs);
    if (onlyEspn.length) console.log("  Only in ESPN (home):", onlyEspn);
  }
  if (!awayMatch) {
    const onlyUs = ourAway.filter((id) => !espn.away.includes(id));
    const onlyEspn = espn.away.filter((id) => !ourAway.includes(id));
    if (onlyUs.length) console.log("  Only in ours (away):", onlyUs);
    if (onlyEspn.length) console.log("  Only in ESPN (away):", onlyEspn);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
