"""
Pulls this season's data straight from Sleeper's public API (no login,
no API key needed) into data/current_season.json for the site to read.

Usage:
    python3 import_sleeper.py 1368708195236724736
    (or just: python3 import_sleeper.py   -- uses the LEAGUE_ID default below)

Run this any time you want to refresh the site (e.g. after games finish
each week). It's a manual, on-demand pull -- nothing runs automatically.
"""
import sys
import json
import time
import urllib.request
from pathlib import Path

LEAGUE_ID_DEFAULT = "1368708195236724736"
BASE = "https://api.sleeper.app/v1"


def get(url):
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode())


def fetch_league_data(league_id):
    print(f"Fetching league {league_id} ...")
    league = get(f"{BASE}/league/{league_id}")
    print(f"  League: {league.get('name')} ({league.get('season')})")

    users = get(f"{BASE}/league/{league_id}/users")
    rosters = get(f"{BASE}/league/{league_id}/rosters")

    user_by_id = {u["user_id"]: u for u in users}

    teams = []
    for r in rosters:
        owner = user_by_id.get(r.get("owner_id"), {})
        metadata = owner.get("metadata") or {}
        team_name = metadata.get("team_name") or owner.get("display_name") or f"Roster {r['roster_id']}"
        settings = r.get("settings", {}) or {}
        teams.append({
            "roster_id": r["roster_id"],
            "owner_display_name": owner.get("display_name"),
            "team_name": team_name,
            "avatar": owner.get("avatar"),
            "wins": settings.get("wins"),
            "losses": settings.get("losses"),
            "ties": settings.get("ties"),
            "fpts": (settings.get("fpts", 0) or 0) + (settings.get("fpts_decimal", 0) or 0) / 100,
            "fpts_against": (settings.get("fpts_against", 0) or 0) + (settings.get("fpts_against_decimal", 0) or 0) / 100,
            "waiver_budget_used": settings.get("waiver_budget_used"),
        })
    teams.sort(key=lambda t: (-(t["wins"] or 0), -(t["fpts"] or 0)))

    # Matchups: pull every week that has data (stop after a few empty weeks).
    # Capped at 17 -- most fantasy leagues (including this one) finish by
    # Week 17 even though the NFL season itself runs to Week 18, since Week
    # 18 lineups are unreliable (teams resting starters). Bump this back to
    # 19 if this league is ever configured for an 18-week season.
    matchups_by_week = {}
    projections_by_week = {}
    empty_streak = 0
    for week in range(1, 18):
        try:
            wk = get(f"{BASE}/league/{league_id}/matchups/{week}")
        except Exception:
            wk = []
        if not wk:
            empty_streak += 1
            if empty_streak >= 3:
                break
            continue
        empty_streak = 0
        matchups_by_week[str(week)] = wk
        time.sleep(0.1)  # be polite to the API

        # Weekly player projections (used to compute the "Eberflus" award --
        # the projected favorite who ends up losing by the largest margin).
        # NOTE: undocumented endpoint on a different host than the rest of
        # the v1 API; wrapped defensively so a change here can't break the
        # rest of the import.
        proj_map = {}
        try:
            for pos in ("QB", "RB", "WR", "TE", "K", "DEF"):
                url = f"https://api.sleeper.app/projections/nfl/{league.get('season')}/{week}?season_type=regular&position[]={pos}"
                for entry in get(url) or []:
                    pid = entry.get("player_id") or (entry.get("player") or {}).get("player_id")
                    stats = entry.get("stats") or {}
                    pts = stats.get("pts_ppr", stats.get("pts_half_ppr", stats.get("pts_std")))
                    if pid and isinstance(pts, (int, float)):
                        proj_map[str(pid)] = pts
        except Exception:
            proj_map = {}
        if proj_map:
            projections_by_week[str(week)] = proj_map

    # Transactions (waivers/trades/drops) -- for the "Waivers & Trades" tab.
    # Sleeper's "round" here lines up with the week number.
    transactions = []
    for week in range(1, 18):
        try:
            tx = get(f"{BASE}/league/{league_id}/transactions/{week}")
        except Exception:
            tx = []
        for t in (tx or []):
            if t.get("status") == "complete":
                t["week"] = week
                transactions.append(t)
        time.sleep(0.05)

    # Draft: used for the "Best In Show" tab (1st round pick, drafted-vs-waiver
    # tagging). Sleeper keeps one draft per league per season.
    draft_picks = []
    try:
        drafts = get(f"{BASE}/league/{league_id}/drafts")
        if drafts:
            draft_id = drafts[0]["draft_id"]
            draft_picks = get(f"{BASE}/draft/{draft_id}/picks") or []
    except Exception:
        draft_picks = []

    # Only fetch the (large, ~5MB) full player list if we actually need names
    # for players referenced in the draft or in weekly scoring -- then trim
    # it down to just those IDs so the output file stays small. Sleeper asks
    # that /players/nfl not be called more than once a day.
    referenced_ids = {str(p.get("player_id")) for p in draft_picks if p.get("player_id")}
    for wk in matchups_by_week.values():
        for m in wk:
            for pid in (m.get("players_points") or {}).keys():
                referenced_ids.add(str(pid))
    for t in transactions:
        for pid in (t.get("adds") or {}).keys():
            referenced_ids.add(str(pid))
        for pid in (t.get("drops") or {}).keys():
            referenced_ids.add(str(pid))

    players = {}
    if referenced_ids:
        try:
            all_players = get(f"{BASE}/players/nfl")
            for pid in referenced_ids:
                p = all_players.get(pid)
                if p:
                    players[pid] = {
                        "first_name": p.get("first_name"),
                        "last_name": p.get("last_name"),
                        "position": p.get("position"),
                        "team": p.get("team"),
                    }
        except Exception:
            players = {}

    return {
        "league_id": league_id,
        "name": league.get("name"),
        "season": league.get("season"),
        "status": league.get("status"),
        "teams": teams,
        "matchups_by_week": matchups_by_week,
        "projections_by_week": projections_by_week,
        "transactions": transactions,
        "draft_picks": draft_picks,
        "players": players,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def main():
    league_id = sys.argv[1] if len(sys.argv) > 1 else LEAGUE_ID_DEFAULT
    data = fetch_league_data(league_id)
    out_path = Path(__file__).resolve().parent.parent / "site" / "data" / "current_season.json"
    out_path.write_text(json.dumps(data, indent=2, default=str))
    print(f"Wrote {out_path}")
    print(f"  {len(data['teams'])} teams, {len(data['matchups_by_week'])} weeks of matchups, "
          f"{len(data['transactions'])} transactions")


if __name__ == "__main__":
    main()
