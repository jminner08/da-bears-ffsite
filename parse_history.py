"""
Parses the commissioner's historical FF_info_<year>.xlsx files into one
consolidated data/history.json that the website reads.

Usage:
    python3 parse_history.py /path/to/FF_Info_2022.xlsx /path/to/FF_info_2023_.xlsx ...

Notes on data quality (read this before trusting numbers blindly):
- Each file's "Win-Loss-Records", "Achievements", and "Past history" tabs are
  used as the source of truth for that file's season, since they're
  consistent across years.
- The "Standings"/"Standing and Waiver" tab is only used for PF/PA/Waiver
  info. In FF_info_2024.xlsx, that tab is byte-for-byte identical to the
  2023 file's tab (a stale copy-paste) -- it is INCLUDED but flagged with
  "suspect_stale": true so the site can warn about it instead of silently
  showing wrong numbers.
- Weekly matchup tabs (Week 1..17) are NOT parsed in this version -- the
  format drifts too much year to year to do reliably. Standings, records,
  awards, and single-game history are all in scope.
- KNOWN QUIRK: the 2022 and 2023 files' "Achievements" tab labels Cronk's
  column header "Dave" instead of "Cronk" (2024/2025 use "Cronk"). Without
  accounting for this, the column-detection logic drops that column entirely
  AND miscalculates which column holds the award name itself (landing one
  column too far right, producing award names like "1" instead of "KBZ").
  OWNER_ALIASES below maps known nickname variants to the canonical
  OWNER_REGISTRY key so this parses correctly across all four years.
"""
import sys
import json
import re
import openpyxl
from pathlib import Path

# Owner nickname -> (legacy team name, real name), taken from the earliest
# (2022) file where full team names + real names were both present.
OWNER_REGISTRY = {
    "Moss":   {"team": "MossEisley Troopers", "real_name": "Bobby Moss"},
    "Luke":   {"team": "Led Tasso", "real_name": "Luke Blanchette"},
    "Josh":   {"team": "Grizzly Gregoire", "real_name": "Josh Gregoire"},
    "Randy":  {"team": "Sir Mixon Lot", "real_name": "Randy Blanchette"},
    "Micah":  {"team": "The Purge", "real_name": "Micah Gentry"},
    "Alex":   {"team": "Bench Points", "real_name": "Alex Schodrof"},
    "Todd":   {"team": "Boba Feta Cheese", "real_name": "Todd Hoffman"},
    "Cronk":  {"team": "Baba Yaga", "real_name": "Dave Cronk"},
    "Austin": {"team": "I Don't Know What I'm Doing", "real_name": "Austin Smith"},
    "Jason":  {"team": "K-Aaron Rodgers", "real_name": "Jason Minner"},
}

# Known nickname variants seen in the source spreadsheets, mapped to the
# canonical OWNER_REGISTRY key. Add new variants here if a future file uses
# a different label for an existing owner.
OWNER_ALIASES = {
    "Dave": "Cronk",
}


def canonical_owner(name):
    """Resolve a raw cell value to a canonical OWNER_REGISTRY key, or None."""
    if not isinstance(name, str):
        return None
    name = name.strip()
    if name in OWNER_REGISTRY:
        return name
    return OWNER_ALIASES.get(name)


YEAR_RE = re.compile(r"(20\d{2})")


def guess_year(filename):
    m = YEAR_RE.search(filename)
    return int(m.group(1)) if m else None


def find_sheet(wb, *candidates):
    for name in wb.sheetnames:
        if name.strip() in candidates:
            return wb[name]
    return None


def parse_win_loss(ws):
    """Returns list of dicts: {owner, weekly:[...], wins, losses, ties, byes,
    playoff_wins, total_games, final_standing}"""
    if ws is None:
        return []
    header_row = None
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
        for c in row:
            if c.value == "Team":
                header_row = c.row
                break
        if header_row:
            break
    if not header_row:
        return []

    headers = {}
    for c in ws[header_row]:
        if c.value is not None:
            headers[c.value] = c.column

    week_cols = [(k, v) for k, v in headers.items() if isinstance(k, str) and k.startswith("Week ")]
    week_cols.sort(key=lambda kv: int(kv[0].split(" ")[1]))

    results = []
    r = header_row + 1
    while r <= ws.max_row:
        owner_cell = ws.cell(row=r, column=headers["Team"])
        owner = canonical_owner(owner_cell.value)
        if owner_cell.value is None:
            break
        if owner is None:
            # stop at the "Projections" recap block that follows the table
            break
        weekly = []
        for wk_name, col in week_cols:
            v = ws.cell(row=r, column=col).value
            weekly.append(v)

        def get(name):
            col = headers.get(name)
            return ws.cell(row=r, column=col).value if col else None

        results.append({
            "owner": owner,
            "weekly": weekly,
            "wins": get("Total Wins"),
            "losses": get("Total Losses"),
            "ties": get("Total Ties"),
            "byes": get("Total Byes"),
            "playoff_wins": get("Playoff Wins"),
            "total_games": get("Total Games"),
            "final_standing": get("Final Standings"),
        })
        r += 1
    return results


# Award names as they appear on the weekly "Week N" tabs -> canonical award
# name (matching the Achievements tab's season-total names). Confirmed by
# inspecting all 4 files: the label always sits in column A of each Week
# tab, with the winner name in the next column and their points after that.
WEEKLY_AWARD_ALIASES = {
    "kneel before zod": "KBZ",
    "instagib": "Instagib",
    "game over": "GameOver",
    "pine": "Riding the Pine",
    "horseshoes": "Horseshoe",
    "horseshoe": "Horseshoe",
    "rocky": "Rocky",
    "eberflus": "Eberbluis",  # 2025-only award; weekly tabs spell it "Eberflus"
    "eberbluis": "Eberbluis",
}


def parse_weekly_awards(wb):
    """Returns { "1": [{"award": "KBZ", "winners": ["Moss"], "points": 52.5}, ...], "2": [...], ... }"""
    result = {}
    week_sheet_re = re.compile(r"^Week\s+(\d+)$")
    for sheet_name in wb.sheetnames:
        m = week_sheet_re.match(sheet_name.strip())
        if not m:
            continue
        week_num = m.group(1)
        ws = wb[sheet_name]
        entries = []
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
            label_cell = row[0]
            if not isinstance(label_cell.value, str):
                continue
            canonical = WEEKLY_AWARD_ALIASES.get(label_cell.value.strip().lower())
            if not canonical:
                continue
            winner_raw = ws.cell(row=label_cell.row, column=2).value
            points = ws.cell(row=label_cell.row, column=3).value
            # One-off data-entry slips in the source sheets sometimes put the
            # winner's name in the points column instead, leaving the winner
            # column blank. If that's the shape we see, treat the points
            # column as the winner name instead.
            if winner_raw is None and isinstance(points, str):
                winner_raw, points = points, None
            winners = []
            if isinstance(winner_raw, str) and winner_raw.strip().lower() != "empty":
                for part in winner_raw.split(","):
                    owner = canonical_owner(part)
                    winners.append(owner if owner else part.strip())
            entries.append({"award": canonical, "winners": winners, "points": points})
        if entries:
            result[week_num] = entries
    return result


def parse_matchups(wb):
    """Returns { "1": [{"owner_a":..., "owner_b":..., "score_a":..., "score_b":...}, ...], ... }

    Every Week N tab has a results table with "Winner"/"Points"/"Loser"/"Points"
    columns (confirmed identical layout across all 4 years: winner name, then
    winner's score, then loser name, then loser's score, in four consecutive
    columns). This is what powers "Last Meeting" on Matchup Previews for
    archived seasons, without needing anything from Sleeper.
    """
    result = {}
    week_sheet_re = re.compile(r"^Week\s+(\d+)$")
    for sheet_name in wb.sheetnames:
        m = week_sheet_re.match(sheet_name.strip())
        if not m:
            continue
        week_num = m.group(1)
        ws = wb[sheet_name]

        winner_col = None
        header_row = None
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
            for c in row:
                if c.value == "Winner":
                    winner_col = c.column
                    header_row = c.row
                    break
            if winner_col:
                break
        if not winner_col:
            continue

        entries = []
        r = header_row + 1
        while r <= ws.max_row:
            winner = canonical_owner(ws.cell(row=r, column=winner_col).value)
            loser = canonical_owner(ws.cell(row=r, column=winner_col + 2).value)
            if winner is None or loser is None:
                break
            score_winner = ws.cell(row=r, column=winner_col + 1).value
            score_loser = ws.cell(row=r, column=winner_col + 3).value
            if isinstance(score_winner, (int, float)) and isinstance(score_loser, (int, float)):
                entries.append({
                    "owner_a": winner, "owner_b": loser,
                    "score_a": round(float(score_winner), 2), "score_b": round(float(score_loser), 2),
                })
            r += 1
        if entries:
            result[week_num] = entries
    return result


def parse_bench_scores(wb):
    """Returns { "1": [{"owner": "Moss", "bench_points": 62.0}, ...], "2": [...], ... }

    Every Week N tab has a small side-table with a "Bench" column header; the
    column immediately to its left holds the owner's name for that row. This
    holds across all 4 years even though the rest of that table's layout
    (labelled "Team" in 2022, "Power Rankings" in 2023-2025) differs.
    """
    result = {}
    week_sheet_re = re.compile(r"^Week\s+(\d+)$")
    for sheet_name in wb.sheetnames:
        m = week_sheet_re.match(sheet_name.strip())
        if not m:
            continue
        week_num = m.group(1)
        ws = wb[sheet_name]

        bench_col = None
        header_row = None
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
            for c in row:
                if c.value == "Bench":
                    bench_col = c.column
                    header_row = c.row
                    break
            if bench_col:
                break
        if not bench_col:
            continue

        owner_col = bench_col - 1
        entries = []
        r = header_row + 1
        while r <= ws.max_row:
            owner = canonical_owner(ws.cell(row=r, column=owner_col).value)
            if owner is None:
                break
            bench_points = ws.cell(row=r, column=bench_col).value
            if isinstance(bench_points, (int, float)):
                entries.append({"owner": owner, "bench_points": round(float(bench_points), 2)})
            r += 1
        if entries:
            result[week_num] = entries
    return result


def parse_achievements(ws):
    """Returns list of {award, counts: {owner: n}}"""
    if ws is None:
        return []
    header_row = None
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
        owners_in_row = [c.value for c in row if canonical_owner(c.value)]
        if len(owners_in_row) >= 5:
            header_row = row[0].row
            break
    if not header_row:
        return []

    owner_cols = {}
    for c in ws[header_row]:
        owner = canonical_owner(c.value)
        if owner:
            owner_cols[owner] = c.column

    award_col = min(owner_cols.values()) - 1
    results = []
    r = header_row + 1
    while r <= ws.max_row:
        award_cell = ws.cell(row=r, column=award_col)
        if award_cell.value is None:
            break
        award = str(award_cell.value).strip()
        counts = {}
        for owner, col in owner_cols.items():
            v = ws.cell(row=r, column=col).value
            counts[owner] = v if v is not None else 0
        results.append({"award": award, "counts": counts})
        r += 1
    return results


def parse_past_history(ws):
    """Returns list of {year, owner, week, points, opponent_note}"""
    if ws is None:
        return []
    anchor_row = None
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
        for c in row:
            if c.value == "Highest Points":
                anchor_row = c.row
                break
        if anchor_row:
            break
    if not anchor_row:
        return []

    results = []
    r = anchor_row + 1
    while r <= ws.max_row:
        row_vals = [ws.cell(row=r, column=c).value for c in range(1, 7)]
        # columns are roughly: rank, year, owner, week, points, "Against X"
        non_null = [v for v in row_vals if v is not None]
        if len(non_null) < 4:
            break
        _, year, owner, week, points, note = (row_vals + [None] * 6)[:6]
        if not isinstance(year, (int, float)):
            break
        year = int(year)
        # Known fat-finger typo in the source workbooks: 2204 -> 2024.
        if year == 2204:
            year = 2024
        owner = canonical_owner(owner) or owner
        results.append({
            "year": year,
            "owner": owner,
            "week": week,
            "points": points,
            "note": note,
        })
        r += 1
    return results


def parse_standings_generic(ws):
    """Handles both the 2022-style (RK/TEAM/PF/PA...) and 2023+-style
    (owner short name + Regular Season/Final Standings/FP/PA/Waiver) tabs."""
    if ws is None:
        return []

    # Style A: 2023+ "Standing(s) and Waiver" - a row with 'Final Standings'
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
        vals = [c.value for c in row]
        if "Final Standings" in vals and ("FP" in vals or "PF" in vals):
            header_row = row[0].row
            headers = {c.value: c.column for c in ws[header_row] if c.value is not None}
            # Find the column that actually holds owner nicknames by checking
            # the first data row, rather than assuming a fixed offset.
            owner_col = None
            for c in ws[header_row + 1]:
                if canonical_owner(c.value):
                    owner_col = c.column
                    break
            if owner_col is None:
                owner_col = min(headers.values()) - 1
            results = []
            r = header_row + 1
            while r <= ws.max_row:
                raw_owner = ws.cell(row=r, column=owner_col).value
                owner = canonical_owner(raw_owner)
                if owner is None:
                    break

                def get(*names):
                    for n in names:
                        col = headers.get(n)
                        if col:
                            v = ws.cell(row=r, column=col).value
                            if v is not None:
                                return v
                    return None

                results.append({
                    "owner": owner,
                    "reg_season_div": get("Regular Season / division"),
                    "final_standing": get("Final Standings"),
                    "pf": get("FP", "PF"),
                    "pa": get("PA"),
                    "waiver_start": get("Start", "Waiver $"),
                    "waiver_remaining": get("Remaining", "Waiver Remaining"),
                    "waiver_spent": get("Waiver Spent"),
                })
                r += 1
            return results

    # Style B: 2022 "RK/TEAM/PF/PA ... Final RK/TEAM/REC/PF/PA/PF-G/PA-G/DIFF"
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row):
        vals = [c.value for c in row]
        if "TEAM" in vals and "RK" in vals:
            header_row = row[0].row
            headers = {}
            for c in ws[header_row]:
                if c.value is not None:
                    headers.setdefault(c.value, c.column)
            results = []
            r = header_row + 1
            while r <= ws.max_row:
                rk = ws.cell(row=r, column=headers.get("RK")).value
                team = ws.cell(row=r, column=headers.get("TEAM")).value
                if rk is None or team is None:
                    break
                # team cell looks like "Name  (Real Name)"
                m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*$", str(team).replace("\xa0", " ").strip())
                team_name, real_name = (m.group(1).strip(), m.group(2).strip()) if m else (str(team).strip(), None)
                results.append({
                    "rank": rk,
                    "team": team_name,
                    "real_name": real_name,
                    "pf": ws.cell(row=r, column=headers.get("PF")).value if headers.get("PF") else None,
                    "pa": ws.cell(row=r, column=headers.get("PA")).value if headers.get("PA") else None,
                })
                r += 1
            return results

    return []


# The "Final Standings" column in the Win-Loss-Records tab is frozen at
# 2022's results and never updated in most years' spreadsheets -- confirmed
# byte-for-byte identical across 2022-2025's original files. The commissioner
# fixed this for 2025 by hand (confirmed: the 2025 file's values are now
# genuinely distinct from the 2022 baseline, not just copied over). Add a
# year here ONLY after verifying its Final Standings column actually holds
# real, distinct results -- don't assume a new file upload fixed it without
# checking, since the same stale-copy bug could just as easily still be
# there.
TRUSTED_FINAL_STANDINGS_YEARS = {2025}


def parse_file(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    year = guess_year(Path(path).name)

    win_loss_ws = find_sheet(wb, "Win-Loss-Records")
    achievements_ws = find_sheet(wb, "Achievements")
    past_history_ws = find_sheet(wb, "Past history")
    standings_ws = find_sheet(wb, "Standings", "Standing and Waiver".strip())
    if standings_ws is None:
        standings_ws = find_sheet(wb, " Standing and Waiver")

    season = {
        "year": year,
        "source_file": Path(path).name,
        "win_loss_records": parse_win_loss(win_loss_ws),
        "achievements": parse_achievements(achievements_ws),
        "standings": parse_standings_generic(standings_ws),
        "weekly_awards": parse_weekly_awards(wb),
        "bench_scores": parse_bench_scores(wb),
        "matchups": parse_matchups(wb),
        "final_standings_trusted": year in TRUSTED_FINAL_STANDINGS_YEARS,
    }
    return season, parse_past_history(past_history_ws)


def main(paths):
    seasons = []
    all_history_records = []
    for p in paths:
        season, hist = parse_file(p)
        seasons.append(season)
        all_history_records.extend(hist)

    # Flag the known stale duplicate: FF_info_2024.xlsx Standings tab ==
    # FF_info_2023 Standings tab.
    by_year = {s["year"]: s for s in seasons if s["year"]}
    if 2023 in by_year and 2024 in by_year:
        s23 = {r["owner"]: (r.get("pf"), r.get("pa")) for r in by_year[2023]["standings"]}
        s24 = {r["owner"]: (r.get("pf"), r.get("pa")) for r in by_year[2024]["standings"]}
        if s23 and s23 == s24:
            by_year[2024]["standings_suspect_stale"] = True

    # Safety net: if a year is marked trusted but its Final Standings still
    # matches 2022's (the frozen baseline), something's wrong -- either the
    # fix didn't actually take, or TRUSTED_FINAL_STANDINGS_YEARS was updated
    # too hastily. Warn loudly rather than silently crowning a wrong champion.
    if 2022 in by_year:
        baseline = {r["owner"]: r.get("final_standing") for r in by_year[2022]["win_loss_records"]}
        for year in TRUSTED_FINAL_STANDINGS_YEARS:
            if year == 2022 or year not in by_year:
                continue
            this_year = {r["owner"]: r.get("final_standing") for r in by_year[year]["win_loss_records"]}
            if this_year == baseline:
                print(f"  WARNING: {year} is marked trusted in TRUSTED_FINAL_STANDINGS_YEARS but its "
                      f"Final Standings values are IDENTICAL to 2022's frozen baseline. This is almost "
                      f"certainly still the stale-copy bug, not a real result. Double-check before trusting it.")

    # De-dupe all-time single-game records (same year/owner/week/points can
    # appear in multiple files since each file re-lists prior years' highs).
    seen = set()
    dedup_history = []
    for rec in sorted(all_history_records, key=lambda r: -(r["points"] or 0)):
        key = (rec["year"], rec["owner"], rec["week"], rec["points"])
        if key in seen:
            continue
        seen.add(key)
        dedup_history.append(rec)

    seasons.sort(key=lambda s: (s["year"] is None, s["year"]))

    # Career totals across every parsed season: win-loss plus PF/PA (PF/PA
    # pulled from each season's standings tab, skipping the one flagged as a
    # stale copy-paste so it doesn't double up or distort the career total).
    career = {}
    for season in seasons:
        standings_by_owner = {s["owner"]: s for s in season.get("standings", []) if s.get("owner")}
        for t in season.get("win_loss_records", []):
            c = career.setdefault(t["owner"], {"wins": 0, "losses": 0, "ties": 0, "playoff_wins": 0, "pf": 0, "pa": 0, "championships": 0})
            c["wins"] += t.get("wins") or 0
            c["losses"] += t.get("losses") or 0
            c["ties"] += t.get("ties") or 0
            c["playoff_wins"] += t.get("playoff_wins") or 0
            if season.get("final_standings_trusted") and t.get("final_standing") == 1:
                c["championships"] += 1
            if not season.get("standings_suspect_stale"):
                st = standings_by_owner.get(t["owner"])
                if st:
                    c["pf"] += st.get("pf") or 0
                    c["pa"] += st.get("pa") or 0

    output = {
        "owner_registry": OWNER_REGISTRY,
        "seasons": seasons,
        "all_time_top_scores": dedup_history[:25],
        "career_totals": career,
    }

    out_path = Path(__file__).resolve().parent.parent / "site" / "data" / "history.json"
    out_path.write_text(json.dumps(output, indent=2, default=str))
    print(f"Wrote {out_path}")
    for s in seasons:
        print(f"  {s['year']}: {len(s['win_loss_records'])} teams, "
              f"{len(s['achievements'])} award types, "
              f"{len(s['standings'])} standings rows"
              + (" [STALE STANDINGS - see note]" if s.get("standings_suspect_stale") else ""))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 parse_history.py <file1.xlsx> <file2.xlsx> ...")
        sys.exit(1)
    main(sys.argv[1:])
