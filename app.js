const state = { history: null, current: null };
const DEFAULT_LEAGUE_ID = '1368708195236724736';
const CACHE_KEY = 'ff_current_season_cache';
let selectedYear = null;
let selectedAwardsYear = 'All-Time';

async function loadData() {
  try {
    const res = await fetch('data/history.json');
    state.history = res.ok ? await res.json() : null;
  } catch (e) { state.history = null; }

  // Prefer a cached "Force Update" pull (from this browser) over the file
  // written by the Python import script, since it's more likely to be fresher.
  const cached = readCache();
  if (cached) {
    state.current = cached;
  } else {
    try {
      const res = await fetch('data/current_season.json');
      state.current = res.ok ? await res.json() : null;
    } catch (e) { state.current = null; }
  }

  try {
    const res = await fetch('data/manual_awards.json');
    state.manualAwardsFile = res.ok ? await res.json() : {};
  } catch (e) { state.manualAwardsFile = {}; }

  renderHeader();
  renderCurrent();
  renderWeeklyPreview();
  renderArchive();
  renderAwards();
  renderBenchScores();
  renderBestInShow();
  renderWaiversTrades();
  renderSetup();
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
}

/* Pulls straight from Sleeper's public API in the browser. Sleeper's API is
   read-only and generally reachable cross-origin; if a browser/network
   blocks it, we fall back to telling the user to run the Python script. */
async function fetchSleeperLive(leagueId) {
  const base = 'https://api.sleeper.app/v1';
  const getJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  };

  const league = await getJson(`${base}/league/${leagueId}`);
  const users = await getJson(`${base}/league/${leagueId}/users`);
  const rosters = await getJson(`${base}/league/${leagueId}/rosters`);

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });

  const teams = rosters.map(r => {
    const owner = userById[r.owner_id] || {};
    const metadata = owner.metadata || {};
    const settings = r.settings || {};
    return {
      roster_id: r.roster_id,
      owner_display_name: owner.display_name,
      team_name: metadata.team_name || owner.display_name || `Roster ${r.roster_id}`,
      avatar: owner.avatar,
      wins: settings.wins,
      losses: settings.losses,
      ties: settings.ties,
      fpts: (settings.fpts || 0) + (settings.fpts_decimal || 0) / 100,
      fpts_against: (settings.fpts_against || 0) + (settings.fpts_against_decimal || 0) / 100,
      waiver_budget_used: settings.waiver_budget_used,
    };
  }).sort((a, b) => (b.wins || 0) - (a.wins || 0) || (b.fpts || 0) - (a.fpts || 0));

  const matchups_by_week = {};
  const projections_by_week = {};
  let emptyStreak = 0;
  // Most fantasy leagues (including this one) play a 17-week season even
  // though the NFL itself now has 18 weeks -- Week 18 lineups are unreliable
  // (teams resting starters), so Sleeper leagues are typically configured
  // to finish by Week 17. If this league ever changes to an 18-week season,
  // bump this back up.
  for (let week = 1; week <= 17; week++) {
    let wk = [];
    try { wk = await getJson(`${base}/league/${leagueId}/matchups/${week}`); } catch (e) { wk = []; }
    if (!wk || wk.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 3) break;
      continue;
    }
    emptyStreak = 0;
    matchups_by_week[String(week)] = wk;

    // Weekly player projections, used to compute Eberflus (biggest upset:
    // the projected favorite who ends up losing by the largest margin).
    // NOTE: this endpoint isn't part of Sleeper's officially documented v1
    // API surface -- if it changes shape or disappears, Eberflus just won't
    // compute for that week rather than breaking anything else.
    try {
      const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
      const projLists = await Promise.all(positions.map(pos =>
        fetch(`https://api.sleeper.app/projections/nfl/${league.season}/${week}?season_type=regular&position[]=${pos}`)
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
      ));
      const projMap = {};
      projLists.flat().forEach(p => {
        const pid = p.player_id || (p.player && p.player.player_id);
        const pts = p.stats && (p.stats.pts_ppr ?? p.stats.pts_half_ppr ?? p.stats.pts_std);
        if (pid && typeof pts === 'number') projMap[String(pid)] = pts;
      });
      projections_by_week[String(week)] = projMap;
    } catch (e) { /* projections are best-effort; Eberflus just skips this week */ }
  }

  // Draft + player names, for the "Best In Show" tab.
  let draft_picks = [];
  try {
    const drafts = await getJson(`${base}/league/${leagueId}/drafts`);
    if (drafts && drafts.length) {
      draft_picks = await getJson(`${base}/draft/${drafts[0].draft_id}/picks`) || [];
    }
  } catch (e) { draft_picks = []; }

  // Waiver claims, free agent pickups, and trades -- for the "Waivers & Trades"
  // tab. Sleeper's "round" here lines up with the week number.
  const transactions = [];
  for (let week = 1; week <= 17; week++) {
    try {
      const tx = await getJson(`${base}/league/${leagueId}/transactions/${week}`);
      (tx || []).forEach(t => { if (t.status === 'complete') transactions.push({ ...t, week }); });
    } catch (e) { /* best-effort */ }
  }

  const referencedIds = new Set();
  draft_picks.forEach(p => { if (p.player_id) referencedIds.add(String(p.player_id)); });
  Object.values(matchups_by_week).forEach(wk => {
    wk.forEach(m => Object.keys(m.players_points || {}).forEach(pid => referencedIds.add(String(pid))));
  });
  transactions.forEach(t => {
    Object.keys(t.adds || {}).forEach(pid => referencedIds.add(String(pid)));
    Object.keys(t.drops || {}).forEach(pid => referencedIds.add(String(pid)));
  });

  let players = {};
  if (referencedIds.size) {
    try {
      const allPlayers = await getJson(`${base}/players/nfl`);
      referencedIds.forEach(pid => {
        const p = allPlayers[pid];
        if (p) {
          players[pid] = { first_name: p.first_name, last_name: p.last_name, position: p.position, team: p.team };
        }
      });
    } catch (e) { players = {}; }
  }

  return {
    league_id: leagueId,
    name: league.name,
    season: league.season,
    status: league.status,
    teams,
    matchups_by_week,
    projections_by_week,
    draft_picks,
    transactions,
    players,
    fetched_at: new Date().toLocaleString(),
  };
}

function setUpdateMsg(text, kind) {
  const el = document.getElementById('update-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `update-msg mono${kind ? ' ' + kind : ''}`;
}

async function handleForceUpdate() {
  const btn = document.getElementById('force-update-btn');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  setUpdateMsg('Pulling live data from Sleeper…');
  try {
    const data = await fetchSleeperLive(DEFAULT_LEAGUE_ID);
    state.current = data;
    writeCache(data);
    renderHeader();
    renderCurrent();
    renderWeeklyPreview();
    renderArchive();
    renderBestInShow();
    renderAwards();
    renderBenchScores();
    renderWaiversTrades();
    setUpdateMsg(`Updated from Sleeper at ${data.fetched_at}.`, 'ok');
    renderSetup();
  } catch (err) {
    setUpdateMsg(
      "Couldn't reach Sleeper directly from this browser (likely blocked). " +
      "Run the import script instead — see the instructions below.",
      'error'
    );
    btn.disabled = false;
    btn.textContent = 'Force Update';
  }
}

function renderHeader() {
  const nameEl = document.getElementById('league-name');
  const subEl = document.getElementById('league-sub');
  const pillEl = document.getElementById('status-pill');

  if (state.current) {
    nameEl.textContent = state.current.name || 'DA B.E.A.R.S.';
    subEl.textContent = `${state.current.season} season · updated ${state.current.fetched_at || '?'}`;
    pillEl.textContent = (state.current.status || 'unknown').toUpperCase();
  } else if (state.history) {
    const years = state.history.seasons.map(s => s.year).filter(Boolean);
    nameEl.textContent = 'DA B.E.A.R.S.';
    subEl.textContent = `Archive covers ${Math.min(...years)}–${Math.max(...years)} · no live season data yet`;
    pillEl.textContent = 'ARCHIVE ONLY';
  } else {
    nameEl.textContent = 'DA B.E.A.R.S.';
    subEl.textContent = 'No data loaded yet';
    pillEl.textContent = '--';
  }
}

/* ---------------- Name helpers ----------------
   Every table on the site shows the owner's nickname plus their real first
   name, e.g. "Moss (Bobby)", so it's always clear who's who even though
   team names have changed year to year. */

function firstName(realName) {
  if (!realName) return null;
  return realName.trim().split(/\s+/)[0];
}

function lastName(realName) {
  if (!realName) return null;
  const parts = realName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

// A couple of owners prefer to be shown by last name instead of first name
// in the "(Name)" tag that appears next to team names and nicknames
// site-wide. Add a nickname here to switch that owner to last name.
const USE_LAST_NAME = new Set(['Cronk', 'Moss']);

function ownerDisplayName(owner) {
  const reg = state.history?.owner_registry?.[owner];
  if (!reg) return null;
  return USE_LAST_NAME.has(owner) ? lastName(reg.real_name) : firstName(reg.real_name);
}

function ownerFirstName(owner) {
  return ownerDisplayName(owner);
}

function ownerLabel(owner) {
  const reg = state.history?.owner_registry?.[owner];
  if (!reg) return owner;
  const dn = ownerDisplayName(owner);
  // If the display name would just repeat the nickname itself (e.g. Cronk's
  // last name IS "Cronk"), showing "Cronk (Cronk)" is redundant -- just
  // show the nickname alone.
  if (!dn || dn.toLowerCase() === owner.toLowerCase()) return owner;
  return `${owner} (${dn})`;
}

function ownerTeamLabel(owner) {
  const reg = state.history?.owner_registry?.[owner];
  if (!reg) return owner;
  const dn = ownerDisplayName(owner);
  return `${reg.team}${dn ? ` (${dn})` : ''}`;
}

/* Live-season (Sleeper) usernames mapped to the same canonical owner keys
   used everywhere else, since Sleeper team names change every year and
   don't otherwise tie back to a real person. Confirmed against the league's
   actual 2026 rosters -- update this if anyone's Sleeper username changes
   or a new owner joins. */
const SLEEPER_USERNAME_TO_OWNER = {
  jminner: 'Jason',
  Lskywalker77: 'Luke',
  asutin56: 'Austin',
  '20Alex': 'Alex',
  Cronk45: 'Cronk',
  Rand01TJ: 'Randy',
  tizzzzod: 'Todd',
  GrizzlyGregoire: 'Josh',
  rabidstitch: 'Moss',
  MicahGentry: 'Micah',
};

function liveTeamOwner(team) {
  return SLEEPER_USERNAME_TO_OWNER[team.owner_display_name] || null;
}

function liveTeamLabel(team) {
  const owner = liveTeamOwner(team);
  const fn = owner ? ownerFirstName(owner) : null;
  return fn ? `${team.team_name} (${fn})` : team.team_name;
}

/* ---------------- Sortable tables ----------------
   Generic click-to-sort for any <table class="sortable">. Reads the
   data-sort-key / data-sort-type ("num" or "text") off each <th>, then
   reorders <tbody> rows by matching data-* attributes on each <td>
   (data-sort-value, falling back to the cell's text content). */

function makeSortable(table) {
  if (!table || table.dataset.sortableBound) return;
  table.dataset.sortableBound = 'true';
  const headRow = table.querySelector('thead tr');
  if (!headRow) return;

  headRow.querySelectorAll('th[data-sort-key]').forEach((th, colIndex) => {
    th.classList.add('sortable-th');
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      const type = th.dataset.sortType || 'text';
      const current = th.dataset.sortDir === 'asc' ? 'asc' : (th.dataset.sortDir === 'desc' ? 'desc' : null);
      const nextDir = current === 'desc' ? 'asc' : 'desc';

      headRow.querySelectorAll('th').forEach(h => { delete h.dataset.sortDir; h.classList.remove('sort-asc', 'sort-desc'); });
      th.dataset.sortDir = nextDir;
      th.classList.add(nextDir === 'asc' ? 'sort-asc' : 'sort-desc');

      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((rowA, rowB) => {
        const cellA = rowA.children[colIndex];
        const cellB = rowB.children[colIndex];
        const rawA = cellA?.dataset.sortValue ?? cellA?.textContent ?? '';
        const rawB = cellB?.dataset.sortValue ?? cellB?.textContent ?? '';
        let cmp;
        if (type === 'num') {
          const numA = parseFloat(rawA); const numB = parseFloat(rawB);
          const a = isNaN(numA) ? -Infinity : numA;
          const b = isNaN(numB) ? -Infinity : numB;
          cmp = a - b;
        } else {
          cmp = String(rawA).localeCompare(String(rawB));
        }
        return nextDir === 'asc' ? cmp : -cmp;
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

function bindSortables(root) {
  root.querySelectorAll('table.sortable').forEach(makeSortable);
}

/* ---------------- Current season ---------------- */

function renderCurrent() {
  const el = document.getElementById('panel-current');
  if (!state.current) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="display">No live season pulled yet</div>
        <p>Run the Sleeper import script to pull this season's standings and matchups.</p>
        <p class="card-note">See the "Update Data" tab for the exact command.</p>
      </div>`;
    return;
  }

  const rows = state.current.teams.map((t, i) => `
    <tr class="${i === 0 ? 'rank-1' : ''}${i === 5 ? ' playoff-cutoff' : ''}">
      <td data-sort-value="${i + 1}">${i + 1}</td>
      <td class="name-cell">${liveTeamLabel(t)}</td>
      <td data-sort-value="${t.wins ?? 0}">${t.wins ?? 0}-${t.losses ?? 0}${t.ties ? `-${t.ties}` : ''}</td>
      <td data-sort-value="${t.fpts ?? 0}">${(t.fpts ?? 0).toFixed(1)}</td>
      <td data-sort-value="${t.fpts_against ?? 0}">${(t.fpts_against ?? 0).toFixed(1)}</td>
    </tr>`).join('');

  const weeks = Object.keys(state.current.matchups_by_week || {}).map(Number).sort((a, b) => a - b);
  // Sleeper often pre-generates the whole season's matchup pairings up front
  // (with 0 points) before any games are played, so "last week we have data
  // for" isn't the same as "last week that's actually happened." Use the
  // last week where someone actually scored points instead.
  const playedWeeks = weeks.filter(w =>
    (state.current.matchups_by_week[String(w)] || []).some(m => (m.points || 0) > 0)
  );
  const lastWeek = playedWeeks.length ? playedWeeks[playedWeeks.length - 1] : null;

  let matchupsHtml = '';
  if (lastWeek) {
    const wk = state.current.matchups_by_week[String(lastWeek)];
    const byMatchupId = {};
    wk.forEach(m => {
      if (!byMatchupId[m.matchup_id]) byMatchupId[m.matchup_id] = [];
      byMatchupId[m.matchup_id].push(m);
    });
    const teamByRoster = {};
    state.current.teams.forEach(t => { teamByRoster[t.roster_id] = liveTeamLabel(t); });
    const gowPair = computeGameOfWeekPair(lastWeek);

    // Mark any score that's actually in the merged all-time top 10 (see
    // computeTop10Scores / the Season Archive & Records tab) with a * so a
    // record-setting week is obvious right on the scoreboard, not just
    // buried in the records table.
    const top10ThisWeek = new Set(
      computeTop10Scores()
        .filter(r => r.live && r.week === lastWeek)
        .map(r => r.roster_id)
    );

    const cards = Object.values(byMatchupId).map(pair => {
      if (pair.length < 2) return '';
      const [a, b] = pair;
      const scoreA = a.points ?? 0, scoreB = b.points ?? 0;
      const resultA = scoreA > scoreB ? 'W' : (scoreA < scoreB ? 'L' : 'T');
      const resultB = scoreB > scoreA ? 'W' : (scoreB < scoreA ? 'L' : 'T');
      const isGow = gowPair && gowPair.has(a.roster_id) && gowPair.has(b.roster_id);
      const aStar = top10ThisWeek.has(a.roster_id) ? ' *' : '';
      const bStar = top10ThisWeek.has(b.roster_id) ? ' *' : '';
      return `<div class="card matchup-card${isGow ? ' game-of-week' : ''}">
        ${isGow ? `<div class="gow-badge">🔥 Game of the Week</div>` : ''}
        <div class="matchup-row"><span class="name">${teamByRoster[a.roster_id] || a.roster_id}</span><span class="stat">${resultA} ${scoreA.toFixed(1)}${aStar}</span></div>
        <div class="matchup-row"><span class="name">${teamByRoster[b.roster_id] || b.roster_id}</span><span class="stat">${resultB} ${scoreB.toFixed(1)}${bStar}</span></div>
      </div>`;
    }).join('');

    const hasTop10Star = top10ThisWeek.size > 0;

    matchupsHtml = `
      <h2 class="section-title">Week ${lastWeek} Matchups</h2>
      <div class="preview-grid">${cards}</div>
      ${hasTop10Star ? `<p class="card-note" style="margin-top:8px;">* top-10 all-time single-week score — see Season Archive &amp; Records.</p>` : ''}
    `;
  }

  el.innerHTML = `
    <h2 class="section-title">Current Standings</h2>
    <p class="card-note" style="margin-bottom:12px;">Orange line marks the playoff cutoff (top 6).</p>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="rank" data-sort-type="num">#</th>
        <th data-sort-key="team">Team</th>
        <th data-sort-key="record" data-sort-type="num">Record</th>
        <th data-sort-key="pf" data-sort-type="num">PF</th>
        <th data-sort-key="pa" data-sort-type="num">PA</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${matchupsHtml}
  `;
  bindSortables(el);
}

function renderWeeklyPreview() {
  const el = document.getElementById('panel-preview');
  if (!state.current) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="display">No live season pulled yet</div>
        <p>Run the Sleeper import script (or Force Update on the Administration tab) to pull this season's data.</p>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div id="power-rankings-section"></div>
    <div id="preview-section"></div>
  `;
  renderPowerRankingsSection();
  renderPreviewSection();
}

/* ---------------- Power Rankings ----------------
   A blended rank combining season record, season-long scoring average, and
   recent form (last 3 played weeks), the standard formula fantasy sites use
   for "power rankings" as distinct from plain win-loss standings. Each of
   the three factors is scored by relative rank among the league (best team
   in a factor scores 100, worst scores 0), then combined 40% record / 30%
   season average / 30% recent form, since recent form gives lower-ranked
   but hot teams a boost the raw standings can't show.

   Everything here is computed directly from matchups_by_week rather than
   trusting Sleeper's cumulative win/loss field, specifically so the same
   function can reconstruct "as of last week" for the week-over-week
   movement column -- no separate history/snapshot storage needed. */

function playedWeeksList() {
  return Object.keys(state.current.matchups_by_week || {})
    .map(Number)
    .filter(w => (state.current.matchups_by_week[String(w)] || []).some(m => (m.points || 0) > 0))
    .sort((a, b) => a - b);
}

function computeStandingsThroughWeek(maxWeek) {
  const byRoster = {};
  state.current.teams.forEach(t => { byRoster[t.roster_id] = { wins: 0, losses: 0, ties: 0, scores: [] }; });

  playedWeeksList().filter(w => w <= maxWeek).forEach(w => {
    const wk = state.current.matchups_by_week[String(w)];
    const byMatchup = {};
    wk.forEach(m => { (byMatchup[m.matchup_id] = byMatchup[m.matchup_id] || []).push(m); });
    Object.values(byMatchup).forEach(pair => {
      if (pair.length < 2) return;
      const [a, b] = pair;
      const aScore = a.points || 0, bScore = b.points || 0;
      if (byRoster[a.roster_id]) byRoster[a.roster_id].scores.push(aScore);
      if (byRoster[b.roster_id]) byRoster[b.roster_id].scores.push(bScore);
      if (aScore > bScore) { byRoster[a.roster_id].wins++; byRoster[b.roster_id].losses++; }
      else if (bScore > aScore) { byRoster[b.roster_id].wins++; byRoster[a.roster_id].losses++; }
      else { byRoster[a.roster_id].ties++; byRoster[b.roster_id].ties++; }
    });
  });
  return byRoster;
}

function computePowerRankings(maxWeek) {
  const standings = computeStandingsThroughWeek(maxWeek);
  const list = state.current.teams.map(t => {
    const s = standings[t.roster_id] || { wins: 0, losses: 0, ties: 0, scores: [] };
    const gamesPlayed = s.scores.length;
    const winPct = s.wins / Math.max(1, s.wins + s.losses + s.ties);
    const seasonAvg = gamesPlayed ? s.scores.reduce((a, b) => a + b, 0) / gamesPlayed : 0;
    const recent = s.scores.slice(-3);
    const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : seasonAvg;
    return { team: t, wins: s.wins, losses: s.losses, ties: s.ties, gamesPlayed, winPct, seasonAvg, recentAvg };
  });

  if (!list.some(s => s.gamesPlayed > 0)) return null;

  const n = list.length;
  const rankScore = (key) => {
    const sorted = [...list].sort((a, b) => b[key] - a[key]);
    const scoreByRoster = new Map();
    sorted.forEach((s, i) => scoreByRoster.set(s.team.roster_id, n > 1 ? (n - 1 - i) / (n - 1) * 100 : 100));
    return scoreByRoster;
  };
  const winScores = rankScore('winPct');
  const pfScores = rankScore('seasonAvg');
  const recentScores = rankScore('recentAvg');

  return list.map(s => {
    const rid = s.team.roster_id;
    const powerScore = 0.4 * winScores.get(rid) + 0.3 * pfScores.get(rid) + 0.3 * recentScores.get(rid);
    return { ...s, powerScore };
  }).sort((a, b) => b.powerScore - a.powerScore);
}

/* Same algorithm as the live-season functions above, but for an archived
   year, keyed by owner nickname instead of roster_id since past seasons
   have no live roster data -- just the week-by-week head-to-head results
   parsed from that year's Excel file (season.matchups). */
function historicalPlayedWeeks(season) {
  return Object.keys(season.matchups || {}).map(Number).sort((a, b) => a - b);
}

function computeHistoricalStandingsThroughWeek(season, maxWeek) {
  const byOwner = {};
  Object.keys(state.history.owner_registry || {}).forEach(o => { byOwner[o] = { wins: 0, losses: 0, ties: 0, scores: [] }; });

  historicalPlayedWeeks(season).filter(w => w <= maxWeek).forEach(w => {
    (season.matchups[String(w)] || []).forEach(m => {
      const a = m.owner_a, b = m.owner_b;
      if (!byOwner[a] || !byOwner[b]) return;
      byOwner[a].scores.push(m.score_a);
      byOwner[b].scores.push(m.score_b);
      if (m.score_a > m.score_b) { byOwner[a].wins++; byOwner[b].losses++; }
      else if (m.score_b > m.score_a) { byOwner[b].wins++; byOwner[a].losses++; }
      else { byOwner[a].ties++; byOwner[b].ties++; }
    });
  });
  return byOwner;
}

function computeHistoricalPowerRankings(season, maxWeek) {
  const standings = computeHistoricalStandingsThroughWeek(season, maxWeek);
  const list = Object.keys(state.history.owner_registry || {}).map(owner => {
    const s = standings[owner] || { wins: 0, losses: 0, ties: 0, scores: [] };
    const gamesPlayed = s.scores.length;
    const winPct = s.wins / Math.max(1, s.wins + s.losses + s.ties);
    const seasonAvg = gamesPlayed ? s.scores.reduce((a, b) => a + b, 0) / gamesPlayed : 0;
    const recent = s.scores.slice(-3);
    const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : seasonAvg;
    return { owner, wins: s.wins, losses: s.losses, ties: s.ties, gamesPlayed, winPct, seasonAvg, recentAvg };
  });

  if (!list.some(s => s.gamesPlayed > 0)) return null;

  const n = list.length;
  const rankScore = (key) => {
    const sorted = [...list].sort((a, b) => b[key] - a[key]);
    const scoreByOwner = new Map();
    sorted.forEach((s, i) => scoreByOwner.set(s.owner, n > 1 ? (n - 1 - i) / (n - 1) * 100 : 100));
    return scoreByOwner;
  };
  const winScores = rankScore('winPct');
  const pfScores = rankScore('seasonAvg');
  const recentScores = rankScore('recentAvg');

  return list.map(s => {
    const powerScore = 0.4 * winScores.get(s.owner) + 0.3 * pfScores.get(s.owner) + 0.3 * recentScores.get(s.owner);
    return { ...s, powerScore };
  }).sort((a, b) => b.powerScore - a.powerScore);
}

let selectedPowerYear = null;
let selectedPowerWeek = null;

function renderPowerRankingsSection() {
  const el = document.getElementById('power-rankings-section');
  if (!el) return;

  const histYears = (state.history?.seasons || []).map(s => s.year).filter(Boolean);
  const liveYear = state.current ? Number(state.current.season) : null;
  const years = Array.from(new Set([...histYears, ...(liveYear ? [liveYear] : [])])).sort((a, b) => a - b);
  if (!years.length) { el.innerHTML = ''; return; }

  if (!selectedPowerYear || !years.includes(selectedPowerYear)) {
    selectedPowerYear = liveYear || Math.max(...years);
  }
  const isLive = selectedPowerYear === liveYear;
  const season = isLive ? null : state.history.seasons.find(s => s.year === selectedPowerYear);

  const played = isLive ? playedWeeksList() : historicalPlayedWeeks(season);
  if (!played.length) { el.innerHTML = ''; return; }

  if (!selectedPowerWeek || !played.includes(selectedPowerWeek)) {
    selectedPowerWeek = played[played.length - 1];
  }
  const currentWeek = selectedPowerWeek;
  const weekIndex = played.indexOf(currentWeek);
  const previousWeek = weekIndex > 0 ? played[weekIndex - 1] : null;

  const rankings = isLive ? computePowerRankings(currentWeek) : computeHistoricalPowerRankings(season, currentWeek);
  if (!rankings) { el.innerHTML = ''; return; }

  const prevRankings = previousWeek
    ? (isLive ? computePowerRankings(previousWeek) : computeHistoricalPowerRankings(season, previousWeek))
    : null;
  const idOf = (r) => isLive ? r.team.roster_id : r.owner;
  const prevRankById = new Map();
  if (prevRankings) prevRankings.forEach((r, i) => prevRankById.set(idOf(r), i + 1));

  const movementCell = (id, currentRank) => {
    if (!prevRankById.has(id)) return `<span class="card-note">New</span>`;
    const prevRank = prevRankById.get(id);
    const delta = prevRank - currentRank; // positive = moved up
    if (delta === 0) return `<span class="card-note">–</span>`;
    const cls = delta > 0 ? 'move-up' : 'move-down';
    const arrow = delta > 0 ? '▲' : '▼';
    return `<span class="${cls}">${arrow} ${Math.abs(delta)}</span>`;
  };

  const rows = rankings.map((r, i) => {
    const id = idOf(r);
    const rank = i + 1;
    const label = isLive ? liveTeamLabel(r.team) : ownerTeamLabel(r.owner);
    return `<tr class="${i === 0 ? 'rank-1' : ''}">
      <td data-sort-value="${rank}">${rank}</td>
      <td data-sort-value="${prevRankById.has(id) ? (prevRankById.get(id) - rank) : 999}">${movementCell(id, rank)}</td>
      <td class="name-cell">${label}</td>
      <td data-sort-value="${r.wins ?? 0}">${r.wins ?? 0}-${r.losses ?? 0}${r.ties ? `-${r.ties}` : ''}</td>
      <td data-sort-value="${r.seasonAvg}">${r.seasonAvg.toFixed(1)}</td>
      <td data-sort-value="${r.recentAvg}">${r.recentAvg.toFixed(1)}</td>
      <td data-sort-value="${r.powerScore}"><strong>${r.powerScore.toFixed(0)}</strong></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <h2 class="section-title">Power Rankings</h2>
    <div class="year-select">
      ${years.map(y => `<button data-year="${y}" class="${y === selectedPowerYear ? 'active' : ''}">${y}${y === liveYear ? ' (live)' : ''}</button>`).join('')}
    </div>
    <div class="year-select">
      ${played.map(w => `<button data-week="${w}" class="${w === currentWeek ? 'active' : ''}">Wk ${w}</button>`).join('')}
    </div>
    <p class="card-note" style="margin:8px 0 12px;">Blends record (40%), season scoring average (30%), and last-3-week form (30%) into one score out of 100 as of ${selectedPowerYear} Week ${currentWeek} — a team on a hot streak can outrank a better record here. Movement compares to Week ${previousWeek ?? '–'}.</p>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="rank" data-sort-type="num">#</th>
        <th data-sort-key="move" data-sort-type="num">Move</th>
        <th data-sort-key="team">Team</th>
        <th data-sort-key="record" data-sort-type="num">Record</th>
        <th data-sort-key="avg" data-sort-type="num">Season Avg</th>
        <th data-sort-key="last3" data-sort-type="num">Last 3 Avg</th>
        <th data-sort-key="power" data-sort-type="num">Power Score</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  bindSortables(el);

  el.querySelectorAll('.year-select')[0].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-year]');
    if (!btn) return;
    selectedPowerYear = Number(btn.dataset.year);
    selectedPowerWeek = null;
    renderPowerRankingsSection();
  });
  el.querySelectorAll('.year-select')[1].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-week]');
    if (!btn) return;
    selectedPowerWeek = Number(btn.dataset.week);
    renderPowerRankingsSection();
  });
}


/* ---------------- Matchup Previews ----------------
   Projected scores + win probability for a chosen week, computed from each
   team's starters' Sleeper projections. Defaults to the next week that
   hasn't been played yet (nobody's scored any points). Win probability is a
   principled estimate, not a real one: Sleeper doesn't publish a variance/
   confidence figure per player, so we assume each starter's actual score
   varies from their projection by roughly 40% of that projection (floor of
   4 points, so low-projection players like kickers/DEF still carry some
   uncertainty), combine those in quadrature per team, and use a normal
   approximation for the win probability. Treat the percentages as a
   reasonable estimate, not gospel. */

let selectedPreviewWeek = null;

function erf(x) {
  // Abramowitz-Stegun approximation.
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function getTeamLastResult(rosterId, beforeWeek) {
  const played = playedWeeksList().filter(w => beforeWeek === undefined || w < beforeWeek);
  for (let i = played.length - 1; i >= 0; i--) {
    const w = played[i];
    const wk = state.current.matchups_by_week[String(w)];
    const entry = wk.find(m => m.roster_id === rosterId);
    if (!entry) continue;
    const opp = wk.find(m => m.matchup_id === entry.matchup_id && m.roster_id !== rosterId);
    if (!opp) continue;
    const score = entry.points || 0, oppScore = opp.points || 0;
    const result = score > oppScore ? 'W' : (score < oppScore ? 'L' : 'T');
    return { week: w, score, oppScore, result, margin: Math.abs(score - oppScore) };
  }
  return null;
}

function lastResultLine(last) {
  if (!last) return 'First game of the season';
  const sign = last.result === 'L' ? '−' : '+';
  return `Wk${last.week}: ${last.result} ${last.score.toFixed(1)}–${last.oppScore.toFixed(1)} (${sign}${last.margin.toFixed(1)})`;
}

/* The closest projected matchup for a given week, used to flag Game of the
   Week -- computed once and shared between the Preview cards and the
   actual-results cards so both agree on the same game. Regular season only
   (weeks 1-14; playoffs run 15-17 for this league). */
function computeGameOfWeekPair(week) {
  if (week > 14) return null;
  const previews = computeMatchupPreviews(week);
  if (!previews.length) return null;
  let best = null;
  previews.forEach(p => { if (!best || p.margin < best.margin) best = p; });
  return best ? new Set([best.rosterA, best.rosterB]) : null;
}

/* The last time these two specific teams played each other, within the
   current live season (historical archive years don't store per-week
   opponent pairings, only weekly awards/bench data, so this can't reach
   back further than the current season). */
function getHeadToHead(rosterA, rosterB, beforeWeek) {
  const played = playedWeeksList().filter(w => beforeWeek === undefined || w < beforeWeek);
  for (let i = played.length - 1; i >= 0; i--) {
    const w = played[i];
    const wk = state.current.matchups_by_week[String(w)];
    const entryA = wk.find(m => m.roster_id === rosterA);
    if (!entryA) continue;
    const entryB = wk.find(m => m.matchup_id === entryA.matchup_id && m.roster_id === rosterB);
    if (!entryB) continue;
    return { week: w, scoreA: entryA.points || 0, scoreB: entryB.points || 0, year: Number(state.current.season) };
  }

  // Not met yet this season -- check past seasons. Historical years get
  // their matchup pairings straight from each Week tab's Winner/Loser
  // columns in the Excel files (parse_history.py), so this works for every
  // archived year (2022-2025), not just ones pulled from Sleeper. Most
  // recent year first, so a rematch from last year takes priority over one
  // from further back.
  const teamA = state.current.teams.find(t => t.roster_id === rosterA);
  const teamB = state.current.teams.find(t => t.roster_id === rosterB);
  const ownerA = teamA ? liveTeamOwner(teamA) : null;
  const ownerB = teamB ? liveTeamOwner(teamB) : null;
  if (!ownerA || !ownerB) return null;

  const histSeasons = [...(state.history?.seasons || [])].sort((a, b) => b.year - a.year);
  for (const season of histSeasons) {
    const weeks = Object.keys(season.matchups || {}).map(Number).sort((a, b) => b - a);
    for (const w of weeks) {
      const entries = season.matchups[String(w)] || [];
      const match = entries.find(e =>
        (e.owner_a === ownerA && e.owner_b === ownerB) || (e.owner_a === ownerB && e.owner_b === ownerA)
      );
      if (!match) continue;
      const scoreA = match.owner_a === ownerA ? match.score_a : match.score_b;
      const scoreB = match.owner_a === ownerA ? match.score_b : match.score_a;
      return { week: w, scoreA, scoreB, year: season.year };
    }
  }
  return null;
}

function teamActualAverageSoFar(rosterId, beforeWeek) {
  const played = playedWeeksList().filter(w => beforeWeek === undefined || w < beforeWeek);
  const scores = [];
  played.forEach(w => {
    const wk = state.current.matchups_by_week[String(w)];
    const entry = wk && wk.find(m => m.roster_id === rosterId);
    if (entry) scores.push(entry.points || 0);
  });
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function computeMatchupPreviews(week) {
  const c = state.current;
  const wk = c && (c.matchups_by_week || {})[String(week)];
  if (!wk || !wk.length) return [];
  const proj = (c.projections_by_week || {})[String(week)] || {};
  const teamByRoster = {};
  c.teams.forEach(t => { teamByRoster[t.roster_id] = liveTeamLabel(t); });

  const byMatchup = {};
  wk.forEach(m => { (byMatchup[m.matchup_id] = byMatchup[m.matchup_id] || []).push(m); });

  // A starter contributes to the projection only if it's a real player with
  // a published projection that week -- an unfilled roster slot (Sleeper
  // uses "0" as a placeholder) or a player missing from that week's
  // projections feed is skipped rather than silently counted as 0 points.
  // If a team ends up with NO valid projected starters at all (lineup not
  // set yet, projections feed incomplete, etc.), fall back to that team's
  // own scoring average so far rather than showing a false 0.0 projection
  // that would otherwise make the matchup look like a 100%-0% lock.
  const teamProjection = (m) => {
    let total = 0, variance = 0, validCount = 0;
    (m.starters || []).forEach(pid => {
      if (!pid || pid === '0') return;
      const p = proj[String(pid)];
      if (typeof p !== 'number') return;
      const sd = Math.max(4, p * 0.4);
      total += p;
      variance += sd * sd;
      validCount++;
    });
    let usedFallback = false;
    if (validCount === 0) {
      const avg = teamActualAverageSoFar(m.roster_id, week);
      if (avg !== null) {
        total = avg;
        variance = Math.pow(Math.max(15, avg * 0.2), 2);
        usedFallback = true;
      }
    }
    return { total, variance, usedFallback };
  };

  return Object.values(byMatchup)
    .filter(pair => pair.length >= 2)
    .map(([a, b]) => {
      const pa = teamProjection(a);
      const pb = teamProjection(b);
      const diff = pa.total - pb.total;
      const sd = Math.sqrt(pa.variance + pb.variance) || 1;
      const probA = normCdf(diff / sd);
      return {
        teamA: teamByRoster[a.roster_id] || a.roster_id,
        teamB: teamByRoster[b.roster_id] || b.roster_id,
        rosterA: a.roster_id,
        rosterB: b.roster_id,
        projA: pa.total,
        projB: pb.total,
        probA: probA * 100,
        probB: (1 - probA) * 100,
        margin: Math.abs(diff),
        fallbackA: pa.usedFallback,
        fallbackB: pb.usedFallback,
      };
    });
}

function renderPreviewSection() {
  const el = document.getElementById('preview-section');
  if (!el || !state.current) { if (el) el.innerHTML = ''; return; }

  const weeks = Object.keys(state.current.matchups_by_week || {}).map(Number).sort((a, b) => a - b);
  if (!weeks.length) { el.innerHTML = ''; return; }

  if (!selectedPreviewWeek || !weeks.includes(selectedPreviewWeek)) {
    const unplayed = weeks.find(w => {
      const wk = state.current.matchups_by_week[String(w)];
      return wk.every(m => !m.points);
    });
    selectedPreviewWeek = unplayed ?? weeks[weeks.length - 1];
  }

  const previews = computeMatchupPreviews(selectedPreviewWeek);
  const gowPair = computeGameOfWeekPair(selectedPreviewWeek);

  const cards = previews.map((p) => {
    const aFav = p.probA >= p.probB;
    const isGow = gowPair && gowPair.has(p.rosterA) && gowPair.has(p.rosterB);
    const lastA = getTeamLastResult(p.rosterA, selectedPreviewWeek);
    const lastB = getTeamLastResult(p.rosterB, selectedPreviewWeek);
    const h2h = getHeadToHead(p.rosterA, p.rosterB, selectedPreviewWeek);

    const projectionsCard = `<div class="card matchup-card${isGow ? ' game-of-week' : ''}">
      ${isGow ? `<div class="gow-badge">🔥 Game of the Week</div>` : ''}
      <div class="matchup-row"><span class="name">${p.teamA}</span><span class="stat">${p.projA.toFixed(1)} — ${aFav ? `<strong>${p.probA.toFixed(0)}%</strong>` : `${p.probA.toFixed(0)}%`}</span></div>
      ${p.fallbackA ? `<div class="matchup-last">Lineup/projections unavailable — using season avg</div>` : ''}
      <div class="matchup-last">${lastResultLine(lastA)}</div>
      <div class="matchup-row"><span class="name">${p.teamB}</span><span class="stat">${p.projB.toFixed(1)} — ${!aFav ? `<strong>${p.probB.toFixed(0)}%</strong>` : `${p.probB.toFixed(0)}%`}</span></div>
      ${p.fallbackB ? `<div class="matchup-last">Lineup/projections unavailable — using season avg</div>` : ''}
      <div class="matchup-last">${lastResultLine(lastB)}</div>
      <p class="card-note" style="margin-top:6px;">Projected margin: ${p.margin.toFixed(1)} pts</p>
    </div>`;

    const liveYearNum = Number(state.current.season);
    const h2hWhen = h2h ? (h2h.year === liveYearNum ? `Week ${h2h.week}` : `${h2h.year}, Week ${h2h.week}`) : null;
    const h2hCard = `<div class="card matchup-card">
      <div class="card-label">Last Meeting</div>
      ${h2h ? `
        <div class="matchup-row"><span class="name">${p.teamA}</span><span class="stat">${h2h.scoreA.toFixed(1)}</span></div>
        <div class="matchup-row"><span class="name">${p.teamB}</span><span class="stat">${h2h.scoreB.toFixed(1)}</span></div>
        <p class="card-note" style="margin-top:4px;">${h2hWhen}</p>
      ` : `<p class="card-note">Haven't played each other before.</p>`}
    </div>`;

    return `<div class="matchup-pair">${projectionsCard}${h2hCard}</div>`;
  }).join('');

  el.innerHTML = `
    <h2 class="section-title">Matchup Previews</h2>
    <div class="year-select">
      ${weeks.map(w => `<button data-week="${w}" class="${w === selectedPreviewWeek ? 'active' : ''}">Wk ${w}</button>`).join('')}
    </div>
    <p class="card-note" style="margin:8px 0 16px;">Win % and margins are estimates from Sleeper's player projections, not guarantees — treat close ones as coin flips. "Last Meeting" checks this season first, then past seasons where available.</p>
    <div class="preview-grid">${cards || '<p class="card-note">No matchup data for this week yet.</p>'}</div>
  `;

  el.querySelectorAll('.year-select button').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPreviewWeek = Number(btn.dataset.week);
      renderPreviewSection();
    });
  });
}

/* ---------------- Season Archive & Records (merged, side by side) ---------------- */

function renderArchive() {
  const el = document.getElementById('panel-archive');
  const histYears = (state.history?.seasons || []).map(s => s.year).filter(Boolean);
  const liveYear = state.current ? Number(state.current.season) : null;
  const years = Array.from(new Set([...histYears, ...(liveYear ? [liveYear] : [])])).sort((a, b) => a - b);

  if (!years.length) {
    el.innerHTML = `<div class="empty-state"><div class="display">No archive data</div></div>`;
    return;
  }
  if (!selectedYear) selectedYear = liveYear || Math.max(...years);

  el.innerHTML = `
    <div class="year-select">
      ${years.map(y => `<button data-year="${y}" class="${y === selectedYear ? 'active' : ''}">${y}${y === liveYear ? ' (live)' : ''}</button>`).join('')}
    </div>
    <div class="two-col">
      <div id="archive-body"></div>
      <div id="top10-body"></div>
    </div>
    <div id="career-body"></div>
  `;

  el.querySelectorAll('.year-select button').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedYear = Number(btn.dataset.year);
      renderArchiveBody(liveYear);
    });
  });

  renderArchiveBody(liveYear);
  renderTop10Body();
  renderCareerBody();
}

function renderArchiveBody(liveYear) {
  const body = document.getElementById('archive-body');

  if (liveYear && selectedYear === liveYear) {
    renderLiveArchiveBody(body);
    return;
  }

  const season = state.history.seasons.find(s => s.year === selectedYear);
  if (!season) { body.innerHTML = ''; return; }

  let warn = '';
  if (season.standings_suspect_stale) {
    warn = `<div class="warn">Heads up: this season's PF/PA/waiver numbers look like a copy-paste of the prior year in the source spreadsheet. Win-loss records below are correct — the PF/PA columns may not be.</div>`;
  }

  // The sheet's "Final Standings" column is frozen at 2022's results in
  // most years and never updated, so by default we don't use it to rank or
  // crown a winner -- EXCEPT for years explicitly verified trustworthy
  // (see TRUSTED_FINAL_STANDINGS_YEARS in parse_history.py), where it's the
  // real final result and we sort by it and crown the champion.
  const trusted = !!season.final_standings_trusted;
  const wl = [...season.win_loss_records].sort((a, b) => {
    if (trusted) {
      const sa = a.final_standing ?? 999, sb = b.final_standing ?? 999;
      if (sa !== sb) return sa - sb;
    }
    const wDiff = (b.wins ?? 0) - (a.wins ?? 0);
    if (wDiff !== 0) return wDiff;
    return (a.losses ?? 0) - (b.losses ?? 0);
  });
  const standingsByOwner = {};
  (season.standings || []).forEach(s => { if (s.owner) standingsByOwner[s.owner] = s; });

  const rows = wl.map((t, i) => {
    const extra = standingsByOwner[t.owner];
    const pf = extra?.pf ?? extra?.fp;
    const pa = extra?.pa;
    const isChamp = trusted && t.final_standing === 1;
    return `<tr class="${isChamp ? 'rank-1' : ''}">
      ${trusted ? `<td data-sort-value="${t.final_standing ?? 999}">${t.final_standing ?? '-'}</td>` : ''}
      <td class="name-cell">${ownerTeamLabel(t.owner)}</td>
      <td data-sort-value="${t.wins ?? 0}">${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}</td>
      <td data-sort-value="${t.playoff_wins ?? 0}">${t.playoff_wins ?? 0}</td>
      <td data-sort-value="${pf ?? -1}">${pf ?? '-'}</td>
      <td data-sort-value="${pa ?? -1}">${pa ?? '-'}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    ${warn}
    <h2 class="section-title">${selectedYear} Win-Loss Records</h2>
    <p class="card-note" style="margin-bottom:12px;">${trusted
      ? `Sorted by final standing — <strong>${ownerTeamLabel(wl[0]?.owner)}</strong> won the league. Click any column header to re-sort.`
      : `Sorted by regular-season record by default — click any column header to re-sort. This league's actual final standings/champion aren't tracked reliably in the source data (see "Administration" tab), so no winner is crowned here.`}</p>
    <table class="sortable">
      <thead><tr>
        ${trusted ? `<th data-sort-key="standing" data-sort-type="num">Standing</th>` : ''}
        <th data-sort-key="team">Team</th>
        <th data-sort-key="record" data-sort-type="num">Record</th>
        <th data-sort-key="playoff" data-sort-type="num">Playoff W</th>
        <th data-sort-key="pf" data-sort-type="num">PF</th>
        <th data-sort-key="pa" data-sort-type="num">PA</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  bindSortables(body);
}

function renderLiveArchiveBody(body) {
  const teams = [...state.current.teams].sort((a, b) => {
    const wDiff = (b.wins ?? 0) - (a.wins ?? 0);
    if (wDiff !== 0) return wDiff;
    return (a.losses ?? 0) - (b.losses ?? 0);
  });

  const rows = teams.map(t => `<tr>
    <td class="name-cell">${liveTeamLabel(t)}</td>
    <td data-sort-value="${t.wins ?? 0}">${t.wins ?? 0}-${t.losses ?? 0}${t.ties ? `-${t.ties}` : ''}</td>
    <td data-sort-value="${t.fpts ?? 0}">${(t.fpts ?? 0).toFixed(1)}</td>
    <td data-sort-value="${t.fpts_against ?? 0}">${(t.fpts_against ?? 0).toFixed(1)}</td>
  </tr>`).join('');

  body.innerHTML = `
    <h2 class="section-title">${state.current.season} Win-Loss Records (live)</h2>
    <p class="card-note" style="margin-bottom:12px;">Pulled straight from Sleeper — updates every time you run Force Update. Team names shown are this year's Sleeper names, with each owner's real first name alongside them.</p>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="team">Team</th>
        <th data-sort-key="record" data-sort-type="num">Record</th>
        <th data-sort-key="pf" data-sort-type="num">PF</th>
        <th data-sort-key="pa" data-sort-type="num">PA</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  bindSortables(body);
}

function computeTop10Scores() {
  // Top 10 single-week scores: historical scores come pre-computed from
  // parse_history.py's "Past history" tab parsing, but that only covers
  // archived years -- the live season's weekly scores are merged in here
  // from Sleeper data so a big week right now shows up immediately instead
  // of waiting for the season to be archived. Anything from the live season
  // that's actually in the top 10 gets a * since it's provisional (the
  // season isn't finalized yet, so it could still be bumped by a bigger
  // week before the year is archived).
  const historicalScores = (state.history?.all_time_top_scores || []).map(r => ({ ...r, live: false }));
  const liveScores = [];
  if (state.current) {
    const liveYearNum = Number(state.current.season);
    Object.entries(state.current.matchups_by_week || {}).forEach(([week, wk]) => {
      wk.forEach(m => {
        if (!m.points) return;
        const team = state.current.teams.find(t => t.roster_id === m.roster_id);
        const owner = team ? liveTeamOwner(team) : null;
        if (!owner) return;
        liveScores.push({ owner, points: m.points, year: liveYearNum, week: Number(week), roster_id: m.roster_id, live: true });
      });
    });
  }
  return [...historicalScores, ...liveScores].sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 10);
}

function renderTop10Body() {
  const body = document.getElementById('top10-body');
  if (!body) return;

  const topScores = computeTop10Scores();
  const scoreRows = topScores.map((r, i) => `
    <tr class="${i === 0 ? 'rank-1' : ''}">
      <td data-sort-value="${i + 1}">${i + 1}</td>
      <td class="name-cell">${ownerLabel(r.owner)}</td>
      <td data-sort-value="${r.points ?? 0}">${r.points}${r.live ? ' *' : ''}</td>
      <td data-sort-value="${r.year ?? 0}">${r.year}, wk ${r.week}</td>
    </tr>`).join('');
  const hasLiveEntry = topScores.some(r => r.live);

  body.innerHTML = `
    <h2 class="section-title">Top 10 Single-Week Scores</h2>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="rank" data-sort-type="num">#</th>
        <th data-sort-key="owner">Owner</th>
        <th data-sort-key="points" data-sort-type="num">Points</th>
        <th data-sort-key="when" data-sort-type="num">When</th>
      </tr></thead>
      <tbody>${scoreRows}</tbody>
    </table>
    ${hasLiveEntry ? `<p class="card-note" style="margin-top:8px;">* from the season in progress — provisional, since the year isn't archived yet.</p>` : ''}
  `;
  bindSortables(body);
}

function renderCareerBody() {
  const body = document.getElementById('career-body');
  if (!body) return;

  // Career totals (win-loss + PF/PA) come pre-computed from parse_history.py
  // for the archived (2022-2025) seasons, which already skips the flagged-
  // stale 2024 standings tab. The live season is merged in on top of that
  // using the Sleeper-username-to-owner mapping -- PF/PA come from Sleeper's
  // own cumulative roster totals, so this is a genuine running total that's
  // current as of whenever Force Update was last run, not a snapshot.
  const career = {};
  Object.entries(state.history.career_totals || {}).forEach(([owner, c]) => {
    career[owner] = { ...c };
  });
  if (state.current) {
    state.current.teams.forEach(t => {
      const owner = liveTeamOwner(t);
      if (!owner) return;
      const c = career[owner] = career[owner] || { wins: 0, losses: 0, ties: 0, playoff_wins: 0, pf: 0, pa: 0, championships: 0 };
      c.wins += t.wins || 0;
      c.losses += t.losses || 0;
      c.ties += t.ties || 0;
      c.pf += t.fpts || 0;
      c.pa += t.fpts_against || 0;
    });
  }
  const careerRows = Object.entries(career)
    .sort((a, b) => (b[1].championships || 0) - (a[1].championships || 0) || b[1].wins - a[1].wins)
    .map(([owner, c]) => {
      const pct = c.wins / Math.max(1, c.wins + c.losses + c.ties) * 100;
      return `
      <tr class="${(c.championships || 0) > 0 ? 'rank-1' : ''}">
        <td class="name-cell">${ownerLabel(owner)}</td>
        <td data-sort-value="${c.championships || 0}">${c.championships || 0}</td>
        <td data-sort-value="${c.wins}">${c.wins}-${c.losses}${c.ties ? `-${c.ties}` : ''}</td>
        <td data-sort-value="${pct}">${pct.toFixed(1)}%</td>
        <td data-sort-value="${c.pf ?? 0}">${(c.pf ?? 0).toFixed(1)}</td>
        <td data-sort-value="${c.pa ?? 0}">${(c.pa ?? 0).toFixed(1)}</td>
      </tr>`;
    }).join('');

  body.innerHTML = `
    <h2 class="section-title">All-Time (Career)</h2>
    <p class="card-note" style="margin-bottom:12px;">Running totals across every archived season plus the live season in progress — PF/PA update automatically each time Force Update runs. Championships only count years where the final standings are verified accurate — see the Season Archive tab for which years qualify.</p>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="owner">Owner</th>
        <th data-sort-key="championships" data-sort-type="num">🏆</th>
        <th data-sort-key="record" data-sort-type="num">Record</th>
        <th data-sort-key="pct" data-sort-type="num">Win %</th>
        <th data-sort-key="pf" data-sort-type="num">PF</th>
        <th data-sort-key="pa" data-sort-type="num">PA</th>
      </tr></thead>
      <tbody>${careerRows}</tbody>
    </table>
  `;
  bindSortables(body);
}

/* ---------------- Awards ----------------
   Card grid, one card per award (like the original design). Year buttons on
   top; Week buttons underneath. "All Weeks" shows season/all-time totals;
   picking a specific week shows just that week's winner(s) for each award,
   sourced from the Week-tab data parse_history.py now pulls in. Picking a
   week while "All-Time" is selected shows that week's winner in every year. */

let selectedAwardsWeek = 'All Weeks';
let selectedAdminWeek = null;

const MANUAL_AWARDS_KEY = 'ff_manual_awards';

function loadManualAwards() {
  const fromFile = state.manualAwardsFile || {};
  let fromLocal = {};
  try { fromLocal = JSON.parse(localStorage.getItem(MANUAL_AWARDS_KEY) || '{}'); } catch (e) { /* ignore */ }
  return { ...fromFile, ...fromLocal };
}

function saveManualAward(year, week, award, data) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(MANUAL_AWARDS_KEY) || '{}'); } catch (e) { all = {}; }
  const key = `${year}:${week}:${award}`;
  all[key] = data;
  try { localStorage.setItem(MANUAL_AWARDS_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
}

function getManualAward(year, week, award) {
  return loadManualAwards()[`${year}:${week}:${award}`] || null;
}

/* Computes the 6 auto-derivable weekly awards for the live/current season
   directly from Sleeper matchup + projections data. Cached per week since
   it's re-derived from raw data each render. */
const _liveAwardsCache = {};

function computeLiveWeeklyAwards(week) {
  if (_liveAwardsCache[week] !== undefined) return _liveAwardsCache[week];
  const c = state.current;
  const wk = c && (c.matchups_by_week || {})[String(week)];
  if (!wk || !wk.length) return (_liveAwardsCache[week] = null);

  const proj = (c.projections_by_week || {})[String(week)] || {};
  const teamByRoster = {};
  c.teams.forEach(t => { teamByRoster[t.roster_id] = liveTeamLabel(t); });

  let kbz = null, instagib = null, gameover = null, pine = null, horseshoe = null, eberflus = null;
  const byMatchup = {};
  wk.forEach(m => { (byMatchup[m.matchup_id] = byMatchup[m.matchup_id] || []).push(m); });

  wk.forEach(m => {
    const score = m.points || 0;
    const rosterTotal = Object.values(m.players_points || {}).reduce((a, b) => a + (b || 0), 0);
    const bench = rosterTotal - score;
    if (!instagib || score > instagib.value) instagib = { roster_id: m.roster_id, value: score };
    if (!gameover || score < gameover.value) gameover = { roster_id: m.roster_id, value: score };
    if (!pine || bench > pine.value) pine = { roster_id: m.roster_id, value: bench };
  });

  Object.values(byMatchup).forEach(pair => {
    if (pair.length < 2) return;
    const [a, b] = pair;
    const aScore = a.points || 0, bScore = b.points || 0;
    const winner = aScore >= bScore ? a : b;
    const loser = aScore >= bScore ? b : a;
    const margin = Math.abs(aScore - bScore);
    if (!kbz || margin > kbz.value) kbz = { roster_id: winner.roster_id, value: margin };
    if (!horseshoe || margin < horseshoe.value) horseshoe = { roster_id: loser.roster_id, value: margin };

    const projScore = (m2) => (m2.starters || []).reduce((sum, pid) => sum + (proj[String(pid)] || 0), 0);
    const favorite = projScore(a) >= projScore(b) ? a : b;
    if (favorite.roster_id !== winner.roster_id) {
      if (!eberflus || margin > eberflus.value) eberflus = { roster_id: favorite.roster_id, value: margin };
    }
  });

  const label = (x) => x ? { team_name: teamByRoster[x.roster_id], value: x.value } : null;
  return (_liveAwardsCache[week] = {
    KBZ: label(kbz),
    Instagib: label(instagib),
    GameOver: label(gameover),
    'Riding the Pine': label(pine),
    Horseshoe: label(horseshoe),
    Eberbluis: label(eberflus),
  });
}

function renderAwards() {
  const el = document.getElementById('panel-awards');
  const histYears = (state.history?.seasons || []).map(s => s.year).filter(Boolean);
  const liveYear = state.current ? Number(state.current.season) : null;
  const years = Array.from(new Set([...histYears, ...(liveYear ? [liveYear] : [])])).sort((a, b) => a - b);

  if (!years.length) {
    el.innerHTML = `<div class="empty-state"><div class="display">No awards data</div></div>`;
    return;
  }

  const yearOptions = ['All-Time', ...years];

  // Union of week numbers actually present anywhere (historical Excel data
  // or the live season's matchups), so the button row works for both a
  // single year and All-Time.
  const weekSet = new Set();
  (state.history?.seasons || []).forEach(s => Object.keys(s.weekly_awards || {}).forEach(w => weekSet.add(Number(w))));
  if (state.current) Object.keys(state.current.matchups_by_week || {}).forEach(w => weekSet.add(Number(w)));
  const weekOptions = ['All Weeks', ...Array.from(weekSet).sort((a, b) => a - b)];

  el.innerHTML = `
    <h2 class="section-title">Awards</h2>
    <div class="year-select">
      ${yearOptions.map(y => `<button data-year="${y}" class="${String(y) === String(selectedAwardsYear) ? 'active' : ''}">${y}</button>`).join('')}
    </div>
    <div class="year-select">
      ${weekOptions.map(w => `<button data-week="${w}" class="${String(w) === String(selectedAwardsWeek) ? 'active' : ''}">${typeof w === 'number' ? `Wk ${w}` : w}</button>`).join('')}
    </div>
    <div id="awards-body"></div>
  `;

  el.querySelector('.year-select').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-year]');
    if (!btn) return;
    selectedAwardsYear = isNaN(Number(btn.dataset.year)) ? btn.dataset.year : Number(btn.dataset.year);
    renderAwards();
  });
  el.querySelectorAll('.year-select')[1].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-week]');
    if (!btn) return;
    selectedAwardsWeek = isNaN(Number(btn.dataset.week)) ? btn.dataset.week : Number(btn.dataset.week);
    renderAwards();
  });

  renderAwardsBody(years, liveYear);
}

function renderAwardsBody(years, liveYear) {
  const body = document.getElementById('awards-body');
  const histSeasonsInScope = selectedAwardsYear === 'All-Time'
    ? (state.history?.seasons || [])
    : (state.history?.seasons || []).filter(s => s.year === selectedAwardsYear);
  const includeLive = liveYear && (selectedAwardsYear === 'All-Time' || selectedAwardsYear === liveYear);

  if (selectedAwardsWeek === 'All Weeks') {
    renderAwardsBodySeasonTotals(body, histSeasonsInScope);
  } else {
    renderAwardsBodyWeekly(body, histSeasonsInScope, selectedAwardsWeek, includeLive ? liveYear : null);
  }
}

function renderAwardsBodySeasonTotals(body, seasonsInScope) {
  const awardOrder = [];
  const totals = {}; // award -> owner -> n

  seasonsInScope.forEach(season => {
    (season.achievements || []).forEach(a => {
      if (!awardOrder.includes(a.award)) awardOrder.push(a.award);
      totals[a.award] = totals[a.award] || {};
      Object.entries(a.counts).forEach(([owner, n]) => {
        totals[a.award][owner] = (totals[a.award][owner] || 0) + (Number(n) || 0);
      });
    });
  });

  const cards = awardOrder.map(award => {
    const counts = totals[award] || {};
    const ranked = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const items = ranked.length
      ? ranked.map(([owner, n]) => `<li>${ownerLabel(owner)}<span class="n">${n}</span></li>`).join('')
      : `<li class="card-note">No wins recorded</li>`;
    return `<div class="award-card card">
      <h3>${award}</h3>
      <ul class="award-list">${items}</ul>
    </div>`;
  }).join('');

  const scopeNote = selectedAwardsYear === 'All-Time'
    ? `Historical totals from the archive${seasonsInScope.length ? ` (${seasonsInScope.map(s => s.year).join(', ')})` : ''}. The live season's season-long totals aren't tallied yet — check week-by-week for this year.`
    : (seasonsInScope.length ? `${selectedAwardsYear} season totals.` : `No archived season totals for ${selectedAwardsYear} yet — check week-by-week instead.`);

  body.innerHTML = `
    <p class="card-note" style="margin-bottom:16px;">${scopeNote}</p>
    <div class="award-grid">${cards || '<p class="card-note">Nothing to show yet.</p>'}</div>
  `;
}

function renderAwardsBodyWeekly(body, seasonsInScope, week, liveYear) {
  const awardOrder = ['KBZ', 'Instagib', 'GameOver', 'Riding the Pine', 'Horseshoe', 'Eberbluis', 'Rocky'];
  const liveComputed = liveYear ? computeLiveWeeklyAwards(week) : null;

  const cards = awardOrder.map(award => {
    const items = [];

    seasonsInScope.forEach(season => {
      const weekEntries = (season.weekly_awards || {})[String(week)] || [];
      const entry = weekEntries.find(e => e.award === award);
      if (!entry) return;
      const who = entry.winners.length ? entry.winners.map(ownerLabel).join(', ') : 'No winner recorded';
      const pts = (typeof entry.points === 'number') ? entry.points.toFixed(1) : '';
      const yearPrefix = selectedAwardsYear === 'All-Time' ? `${season.year}: ` : '';
      items.push(`<li>${yearPrefix}${who}${pts ? `<span class="n">${pts}</span>` : ''}</li>`);
    });

    if (liveYear && award !== 'Rocky') {
      const c = liveComputed && liveComputed[award];
      if (c) {
        const yearPrefix = selectedAwardsYear === 'All-Time' ? `${liveYear}: ` : '';
        items.push(`<li>${yearPrefix}${c.team_name}<span class="n">${c.value.toFixed(1)}</span></li>`);
      } else if (selectedAwardsYear === liveYear) {
        items.push(`<li class="card-note">${award === 'Eberbluis' ? 'No upset this week' : 'No data yet'}</li>`);
      }
    }

    if (liveYear && award === 'Rocky') {
      const manual = getManualAward(liveYear, week, 'Rocky');
      if (manual) {
        const yearPrefix = selectedAwardsYear === 'All-Time' ? `${liveYear}: ` : '';
        const manualTeam = (state.current?.teams || []).find(t => t.team_name === manual.winner);
        const manualLabel = manualTeam ? liveTeamLabel(manualTeam) : manual.winner;
        items.push(`<li>${yearPrefix}${manualLabel}<span class="n">${manual.probability}% win prob</span></li>`);
      } else if (selectedAwardsYear === liveYear) {
        items.push(`<li class="card-note">Not entered yet — set it on the Admin tab</li>`);
      }
    }

    if (!items.length) return '';
    return `<div class="award-card card">
      <h3>${award}</h3>
      <ul class="award-list">${items.join('')}</ul>
    </div>`;
  }).filter(Boolean).join('');

  const scopeNote = selectedAwardsYear === 'All-Time'
    ? `Week ${week} winners across every year on record.`
    : `${selectedAwardsYear}, Week ${week}.`;

  body.innerHTML = `
    <p class="card-note" style="margin-bottom:16px;">${scopeNote}</p>
    <div class="award-grid">${cards || '<p class="card-note">No weekly award data for this selection.</p>'}</div>
  `;
}


/* ---------------- Best In Show ----------------
   Per-team cards for the live/current season only: 1st round pick + their
   running point total, the team's best scorer + running total, and whether
   that best scorer was drafted, picked up off waivers, or acquired by trade.
   Only shown once the draft has happened and Week 1 is in the books, since
   before that there's no "best scorer" or running total yet. */

/* ---------------- Bench Scores ----------------
   Points left on the bench each week -- pulled from the Excel "Bench"
   column for archived seasons (2022-2025), computed live from Sleeper's
   roster-vs-starter point totals for the current season. Same Year/Week
   button pattern as the Awards tab. */

let selectedBenchYear = 'All-Time';
let selectedBenchWeek = 'All Weeks';

function computeLiveBenchForWeek(week) {
  const c = state.current;
  const wk = c && (c.matchups_by_week || {})[String(week)];
  if (!wk || !wk.length) return null;
  return wk.map(m => {
    const score = m.points || 0;
    const rosterTotal = Object.values(m.players_points || {}).reduce((a, b) => a + (b || 0), 0);
    const team = c.teams.find(t => t.roster_id === m.roster_id);
    return { owner: team ? liveTeamOwner(team) : null, label: team ? liveTeamLabel(team) : `Roster ${m.roster_id}`, bench: rosterTotal - score };
  });
}

function renderBenchScores() {
  const el = document.getElementById('panel-bench');
  const histYears = (state.history?.seasons || []).map(s => s.year).filter(Boolean);
  const liveYear = state.current ? Number(state.current.season) : null;
  const years = Array.from(new Set([...histYears, ...(liveYear ? [liveYear] : [])])).sort((a, b) => a - b);

  if (!years.length) {
    el.innerHTML = `<div class="empty-state"><div class="display">No bench score data</div></div>`;
    return;
  }

  const yearOptions = ['All-Time', ...years];
  const weekSet = new Set();
  (state.history?.seasons || []).forEach(s => Object.keys(s.bench_scores || {}).forEach(w => weekSet.add(Number(w))));
  if (state.current) Object.keys(state.current.matchups_by_week || {}).forEach(w => weekSet.add(Number(w)));
  const weekOptions = ['All Weeks', ...Array.from(weekSet).sort((a, b) => a - b)];

  el.innerHTML = `
    <h2 class="section-title">Bench Scores</h2>
    <p class="card-note" style="margin-bottom:12px;">Points left on the bench each week — the higher the number, the more you left on the table.</p>
    <div class="year-select">
      ${yearOptions.map(y => `<button data-year="${y}" class="${String(y) === String(selectedBenchYear) ? 'active' : ''}">${y}${y === liveYear ? ' (live)' : ''}</button>`).join('')}
    </div>
    <div class="year-select">
      ${weekOptions.map(w => `<button data-week="${w}" class="${String(w) === String(selectedBenchWeek) ? 'active' : ''}">${typeof w === 'number' ? `Wk ${w}` : w}</button>`).join('')}
    </div>
    <div id="bench-body"></div>
  `;

  el.querySelector('.year-select').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-year]');
    if (!btn) return;
    selectedBenchYear = isNaN(Number(btn.dataset.year)) ? btn.dataset.year : Number(btn.dataset.year);
    renderBenchScores();
  });
  el.querySelectorAll('.year-select')[1].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-week]');
    if (!btn) return;
    selectedBenchWeek = isNaN(Number(btn.dataset.week)) ? btn.dataset.week : Number(btn.dataset.week);
    renderBenchScores();
  });

  renderBenchBody(years, liveYear);
}

function renderBenchBody(years, liveYear) {
  const body = document.getElementById('bench-body');
  const histSeasonsInScope = selectedBenchYear === 'All-Time'
    ? (state.history?.seasons || [])
    : (state.history?.seasons || []).filter(s => s.year === selectedBenchYear);
  const includeLive = liveYear && (selectedBenchYear === 'All-Time' || selectedBenchYear === liveYear);

  if (selectedBenchWeek === 'All Weeks') {
    renderBenchSeasonAverages(body, histSeasonsInScope, includeLive ? liveYear : null);
  } else {
    renderBenchWeekly(body, histSeasonsInScope, selectedBenchWeek, includeLive ? liveYear : null);
  }
}

function renderBenchSeasonAverages(body, histSeasonsInScope, liveYear) {
  const totals = {}; // owner -> {sum, count}
  histSeasonsInScope.forEach(season => {
    Object.values(season.bench_scores || {}).forEach(weekEntries => {
      weekEntries.forEach(e => {
        const t = totals[e.owner] = totals[e.owner] || { sum: 0, count: 0 };
        t.sum += e.bench_points;
        t.count += 1;
      });
    });
  });

  if (liveYear) {
    playedWeeksList().forEach(w => {
      (computeLiveBenchForWeek(w) || []).forEach(e => {
        if (!e.owner) return;
        const t = totals[e.owner] = totals[e.owner] || { sum: 0, count: 0 };
        t.sum += e.bench;
        t.count += 1;
      });
    });
  }

  const rows = Object.entries(totals)
    .map(([owner, t]) => ({ owner, avg: t.sum / t.count, total: t.sum, count: t.count }))
    .sort((a, b) => b.avg - a.avg)
    .map(r => `<tr>
      <td class="name-cell">${ownerLabel(r.owner)}</td>
      <td data-sort-value="${r.avg}">${r.avg.toFixed(1)}</td>
      <td data-sort-value="${r.total}">${r.total.toFixed(1)}</td>
      <td data-sort-value="${r.count}">${r.count}</td>
    </tr>`).join('');

  const scopeNote = selectedBenchYear === 'All-Time'
    ? 'Average bench points per week, across every season on record.'
    : `${selectedBenchYear} season average.`;

  body.innerHTML = `
    <p class="card-note" style="margin-bottom:16px;">${scopeNote}</p>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="owner">Owner</th>
        <th data-sort-key="avg" data-sort-type="num">Avg Bench / Wk</th>
        <th data-sort-key="total" data-sort-type="num">Total Bench</th>
        <th data-sort-key="weeks" data-sort-type="num">Weeks</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="card-note">No data for this selection.</td></tr>'}</tbody>
    </table>
  `;
  bindSortables(body);
}

function renderBenchWeekly(body, histSeasonsInScope, week, liveYear) {
  const rows = [];

  histSeasonsInScope.forEach(season => {
    const entries = (season.bench_scores || {})[String(week)] || [];
    entries.forEach(e => {
      rows.push({ label: ownerLabel(e.owner), value: e.bench_points, year: season.year });
    });
  });

  if (liveYear) {
    (computeLiveBenchForWeek(week) || []).forEach(e => {
      rows.push({ label: e.label, value: e.bench, year: liveYear });
    });
  }

  rows.sort((a, b) => b.value - a.value);

  const tableRows = rows.map((r, i) => `<tr class="${i === 0 ? 'rank-1' : ''}">
    <td data-sort-value="${i + 1}">${i + 1}</td>
    <td class="name-cell">${selectedBenchYear === 'All-Time' ? `${r.year}: ` : ''}${r.label}</td>
    <td data-sort-value="${r.value}">${r.value.toFixed(1)}</td>
  </tr>`).join('');

  const scopeNote = selectedBenchYear === 'All-Time'
    ? `Week ${week} bench scores across every year on record.`
    : `${selectedBenchYear}, Week ${week}.`;

  body.innerHTML = `
    <p class="card-note" style="margin-bottom:16px;">${scopeNote}</p>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="rank" data-sort-type="num">#</th>
        <th data-sort-key="owner">Owner</th>
        <th data-sort-key="bench" data-sort-type="num">Bench Points</th>
      </tr></thead>
      <tbody>${tableRows || '<tr><td colspan="3" class="card-note">No data for this selection.</td></tr>'}</tbody>
    </table>
  `;
  bindSortables(body);
}

function renderBestInShow() {
  const el = document.getElementById('panel-bestinshow');
  const c = state.current;

  const hasDraft = c && Array.isArray(c.draft_picks) && c.draft_picks.length > 0;
  const hasWeek1 = c && c.matchups_by_week && c.matchups_by_week['1'] && c.matchups_by_week['1'].length > 0;

  if (!c || !hasDraft || !hasWeek1) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="display">Not ready yet</div>
        <p>This tab lights up once the draft is done and Week 1 is final — need${!hasDraft ? " draft data" : ""}${!hasDraft && !hasWeek1 ? " and" : ""}${!hasWeek1 ? " Week 1 results" : ""} first.</p>
      </div>`;
    return;
  }

  const players = c.players || {};
  const playerName = (pid) => {
    const p = players[pid];
    return p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() + (p.position ? ` (${p.position}${p.team ? ` - ${p.team}` : ''})` : '') : `Player ${pid}`;
  };

  // Running point totals per player, per roster, across every week we have.
  const weeks = Object.keys(c.matchups_by_week || {});
  const pointsByRosterPlayer = {}; // roster_id -> { player_id: total }
  weeks.forEach(wk => {
    (c.matchups_by_week[wk] || []).forEach(m => {
      const rid = m.roster_id;
      pointsByRosterPlayer[rid] = pointsByRosterPlayer[rid] || {};
      Object.entries(m.players_points || {}).forEach(([pid, pts]) => {
        pointsByRosterPlayer[rid][pid] = (pointsByRosterPlayer[rid][pid] || 0) + (Number(pts) || 0);
      });
    });
  });

  const draftedByRosterPlayer = new Set(); // "roster_id:player_id"
  c.draft_picks.forEach(p => draftedByRosterPlayer.add(`${p.roster_id}:${p.player_id}`));

  const round1ByRoster = {};
  c.draft_picks.forEach(p => { if (p.round === 1) round1ByRoster[p.roster_id] = p; });

  const acquisitionTag = (rosterId, playerId) => {
    if (draftedByRosterPlayer.has(`${rosterId}:${playerId}`)) {
      return `<span class="tag tag-drafted">Drafted</span>`;
    }
    const tx = (c.transactions || []).find(t =>
      (t.adds && Object.keys(t.adds).includes(String(playerId)) && Object.values(t.adds)[Object.keys(t.adds).indexOf(String(playerId))] == rosterId)
    );
    if (tx) {
      return tx.type === 'trade' ? `<span class="tag tag-trade">Trade</span>` : `<span class="tag tag-waiver">Waiver</span>`;
    }
    return `<span class="tag tag-waiver">Waiver</span>`;
  };

  const cards = c.teams.map(t => {
    const rid = t.roster_id;
    const pick = round1ByRoster[rid];
    const totals = pointsByRosterPlayer[rid] || {};
    let bestPid = null, bestPts = -Infinity;
    Object.entries(totals).forEach(([pid, pts]) => { if (pts > bestPts) { bestPts = pts; bestPid = pid; } });

    const pickRow = pick
      ? `<div class="bis-row"><span class="label">1st Rd Pick</span><span class="val">${playerName(pick.player_id)} — ${(totals[pick.player_id] || 0).toFixed(1)} pts</span></div>`
      : `<div class="bis-row"><span class="label">1st Rd Pick</span><span class="val">—</span></div>`;

    const bestRow = bestPid
      ? `<div class="bis-row"><span class="label">Best Scorer</span><span class="val">${playerName(bestPid)} — ${bestPts.toFixed(1)} pts${acquisitionTag(rid, bestPid)}</span></div>`
      : `<div class="bis-row"><span class="label">Best Scorer</span><span class="val">—</span></div>`;

    return `<div class="bis-card card">
      <h3>${liveTeamLabel(t)}</h3>
      ${pickRow}
      ${bestRow}
    </div>`;
  }).join('');

  el.innerHTML = `
    <h2 class="section-title">Best In Show — ${c.season}</h2>
    <p class="card-note" style="margin-bottom:16px;">Each team's 1st round draft pick and top-scoring player so far, with running point totals.</p>
    <div class="bis-grid">${cards}</div>
  `;
}


/* ---------------- Setup / how to update ---------------- */

/* ---------------- Waivers & Trades ----------------
   Live season only (transaction history isn't something the Excel archives
   have). Shows a running waiver-spend leaderboard (Sleeper already tracks
   this cumulatively per roster) plus a week-by-week log of every completed
   waiver claim, free agent pickup, and trade. */

let selectedWaiverWeek = 'All Weeks';

function playerLabel(pid) {
  const p = state.current.players?.[pid];
  if (!p) return `Player ${pid}`;
  const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
  return p.position ? `${name} (${p.position}${p.team ? ` - ${p.team}` : ''})` : name;
}

function describeTransaction(t, teamByRoster) {
  const rosterIds = t.roster_ids || [];

  if (t.type === 'trade') {
    const parts = rosterIds.map(rid => {
      const gained = Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([pid]) => playerLabel(pid));
      const gainedPicks = (t.draft_picks || []).filter(p => p.owner_id === rid)
        .map(p => `${p.season} Round ${p.round} pick`);
      const all = [...gained, ...gainedPicks];
      return `<strong>${teamByRoster[rid] || `Roster ${rid}`}</strong> got ${all.length ? all.join(', ') : 'nothing (pick-only side)'}`;
    });
    return { type: 'Trade', body: parts.join('<br>'), amount: null };
  }

  const rid = rosterIds[0];
  const added = Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([pid]) => playerLabel(pid));
  const dropped = Object.entries(t.drops || {}).filter(([, r]) => r === rid).map(([pid]) => playerLabel(pid));
  const bid = t.type === 'waiver' ? (t.settings && t.settings.waiver_bid) : null;

  let body = `<strong>${teamByRoster[rid] || `Roster ${rid}`}</strong>`;
  if (added.length) body += ` added ${added.join(', ')}`;
  if (dropped.length) body += `${added.length ? ',' : ''} dropped ${dropped.join(', ')}`;

  return { type: t.type === 'waiver' ? 'Waiver' : 'Free Agent', body, amount: bid };
}

function renderWaiversTrades() {
  const el = document.getElementById('panel-waivers');
  const c = state.current;

  if (!c || !Array.isArray(c.transactions)) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="display">Not ready yet</div>
        <p>Run Force Update (or the import script) to pull this season's waiver and trade history from Sleeper.</p>
      </div>`;
    return;
  }

  const teamByRoster = {};
  c.teams.forEach(t => { teamByRoster[t.roster_id] = liveTeamLabel(t); });

  const spendRows = [...c.teams]
    .sort((a, b) => (b.waiver_budget_used || 0) - (a.waiver_budget_used || 0))
    .map(t => `<tr>
      <td class="name-cell">${liveTeamLabel(t)}</td>
      <td data-sort-value="${t.waiver_budget_used || 0}">$${t.waiver_budget_used || 0}</td>
    </tr>`).join('');

  const weeks = Array.from(new Set(c.transactions.map(t => t.week))).sort((a, b) => a - b);
  const weekOptions = ['All Weeks', ...weeks];

  el.innerHTML = `
    <h2 class="section-title">Waiver Spend (running total)</h2>
    <table class="sortable">
      <thead><tr>
        <th data-sort-key="team">Team</th>
        <th data-sort-key="spend" data-sort-type="num">$ Spent</th>
      </tr></thead>
      <tbody>${spendRows}</tbody>
    </table>

    <h2 class="section-title">Transaction Log</h2>
    <div class="year-select">
      ${weekOptions.map(w => `<button data-week="${w}" class="${String(w) === String(selectedWaiverWeek) ? 'active' : ''}">${typeof w === 'number' ? `Wk ${w}` : w}</button>`).join('')}
    </div>
    <div id="waivers-body"></div>
  `;
  bindSortables(el);

  el.querySelector('.year-select').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-week]');
    if (!btn) return;
    selectedWaiverWeek = isNaN(Number(btn.dataset.week)) ? btn.dataset.week : Number(btn.dataset.week);
    renderWaiversBody(teamByRoster);
  });

  renderWaiversBody(teamByRoster);
}

function renderWaiversBody(teamByRoster) {
  const body = document.getElementById('waivers-body');
  const c = state.current;
  const inScope = selectedWaiverWeek === 'All Weeks'
    ? c.transactions
    : c.transactions.filter(t => t.week === selectedWaiverWeek);

  const sorted = [...inScope].sort((a, b) => b.week - a.week || (b.created || 0) - (a.created || 0));

  const rows = sorted.map(t => {
    const d = describeTransaction(t, teamByRoster);
    return `<div class="card">
      <div class="bis-row"><span class="label">Wk ${t.week} — ${d.type}</span>${d.amount ? `<span class="val">$${d.amount}</span>` : ''}</div>
      <p class="card-note" style="margin-top:4px;">${d.body}</p>
    </div>`;
  }).join('');

  body.innerHTML = `<div class="preview-grid">${rows || '<p class="card-note">No transactions for this selection.</p>'}</div>`;
}

function renderSetup() {
  const el = document.getElementById('panel-setup');
  const liveYear = state.current ? Number(state.current.season) : null;
  const weeks = state.current ? Object.keys(state.current.matchups_by_week || {}).map(Number).sort((a, b) => a - b) : [];

  el.innerHTML = `
    <h2 class="section-title">Administration</h2>

    <div class="card">
      <strong>Pull live data from Sleeper</strong>
      <p class="card-note">Saved in this browser only. If blocked, run <span class="mono">python3 import_sleeper.py YOUR_LEAGUE_ID</span> from <span class="mono">scripts/</span> instead.</p>
      <button id="force-update-btn" class="update-btn mono">Force Update</button>
      <div id="update-msg" class="update-msg mono" style="padding:8px 0 0;"></div>
    </div>

    <div class="card">
      <strong>Rocky — weekly entry</strong>
      <p class="card-note">Sleeper doesn't expose real win probability, so this one's entered by hand: the team that was trailing (lowest win odds) going into Monday night and still won. Saving here updates the Awards tab automatically.</p>
      ${liveYear && weeks.length ? `
        <div id="rocky-admin-body"></div>
      ` : `<p class="card-note">No live season data yet — pull a season above before entering Rocky.</p>`}
    </div>

    <div class="card">
      <strong>Other maintenance</strong>
      <p class="card-note">Re-parse Excel files: <span class="mono">python3 parse_history.py FF_2022.xlsx FF_2023.xlsx FF_2024.xlsx FF_2025.xlsx</span></p>
      <p class="card-note">Run locally: <span class="mono">cd site && python3 -m http.server 8000</span> then open <span class="mono">http://localhost:8000</span></p>
      <p class="card-note">Save Rocky entries permanently: download and save as <span class="mono">site/data/manual_awards.json</span>.</p>
      <button id="export-manual-awards-btn" class="update-btn">Download manual_awards.json</button>
    </div>
  `;

  document.getElementById('force-update-btn').addEventListener('click', handleForceUpdate);

  if (liveYear && weeks.length) {
    if (!selectedAdminWeek || !weeks.includes(selectedAdminWeek)) {
      const playedWeeks = weeks.filter(w =>
        (state.current.matchups_by_week[String(w)] || []).some(m => (m.points || 0) > 0)
      );
      selectedAdminWeek = playedWeeks.length ? playedWeeks[playedWeeks.length - 1] : weeks[0];
    }
    renderRockyAdmin(liveYear, weeks);
  }

  document.getElementById('export-manual-awards-btn').addEventListener('click', () => {
    const data = loadManualAwards();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'manual_awards.json';
    a.click();
    URL.revokeObjectURL(url);
  });
}

function renderRockyAdmin(year, weeks) {
  const body = document.getElementById('rocky-admin-body');
  if (!body) return;
  const teams = (state.current?.teams || []).map(t => ({ value: t.team_name, label: liveTeamLabel(t) })).sort((a, b) => a.label.localeCompare(b.label));
  const existing = getManualAward(year, selectedAdminWeek, 'Rocky');

  body.innerHTML = `
    <div class="year-select">
      ${weeks.map(w => `<button data-week="${w}" class="${w === selectedAdminWeek ? 'active' : ''}">Wk ${w}</button>`).join('')}
    </div>
    <form id="rocky-form" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
      <select name="winner" style="flex:1; min-width:160px; background:var(--felt); border:1px solid var(--felt-line); color:var(--chalk); border-radius:6px; padding:6px 10px; font-family:'IBM Plex Mono',monospace;">
        <option value="">Select team…</option>
        ${teams.map(t => `<option value="${t.value}" ${existing?.winner === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
      </select>
      <input name="probability" type="number" step="0.1" min="0" max="100" placeholder="Win % at the time"
        value="${existing?.probability ?? ''}"
        style="width:150px; background:var(--felt); border:1px solid var(--felt-line); color:var(--chalk); border-radius:6px; padding:6px 10px; font-family:'IBM Plex Mono',monospace;">
      <button type="submit" class="update-btn">Save</button>
      <span id="rocky-save-msg" class="card-note" style="align-self:center;"></span>
    </form>
  `;

  body.querySelectorAll('.year-select button').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedAdminWeek = Number(btn.dataset.week);
      renderRockyAdmin(year, weeks);
    });
  });

  body.querySelector('#rocky-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const winner = e.target.querySelector('[name=winner]').value;
    const probability = e.target.querySelector('[name=probability]').value.trim();
    if (!winner || probability === '') return;
    saveManualAward(year, selectedAdminWeek, 'Rocky', { winner, probability: Number(probability) });
    renderAwards();
    const msg = document.getElementById('rocky-save-msg');
    if (msg) {
      msg.textContent = '✓ Saved';
      msg.style.color = 'var(--win)';
      setTimeout(() => { if (msg.textContent === '✓ Saved') msg.textContent = ''; }, 3000);
    }
  });
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
});

loadData();
