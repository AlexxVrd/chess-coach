"""Daily training plan ("Séance du jour"), streaks and the progress-to-target tracker."""
import json
import time
from datetime import date, datetime, timedelta

from . import db, repertoire, tactics


def _midnight(d: date | None = None) -> int:
    return int(datetime.combine(d or date.today(), datetime.min.time()).timestamp())


def log(kind: str):
    db.run("""INSERT INTO daily_log(day, kind, n) VALUES(?,?,1) ON CONFLICT(day, kind) DO UPDATE SET n=n+1""",
           (date.today().isoformat(), kind))


def _count_today(kind: str) -> int:
    r = db.q1("SELECT n FROM daily_log WHERE day=? AND kind=?", (date.today().isoformat(), kind))
    return r["n"] if r else 0


def activity_days() -> set:
    days = {date.fromtimestamp(r["ts"]) for r in db.q("SELECT ts FROM puzzle_attempts")}
    days |= {date.fromtimestamp(r["ts"]) for r in db.q("SELECT ts FROM tactic_attempts")}
    days |= {date.fromisoformat(r["day"]) for r in db.q("SELECT DISTINCT day FROM daily_log")}
    return days


def streak() -> int:
    days = activity_days()
    cur = date.today()
    if cur not in days:
        cur -= timedelta(days=1)
    n = 0
    while cur in days:
        n += 1
        cur -= timedelta(days=1)
    return n


def rating_progress(tc="rapid"):
    """Current rating, target and a linear-trend ETA based on the last 90 days."""
    s = db.get_settings()
    target = int(s.get("target_rating", 2000))
    rows = db.q("SELECT played_at t, user_elo e FROM games WHERE user_elo IS NOT NULL AND time_class=? ORDER BY played_at", (tc,))
    if not rows:
        rows = db.q("SELECT played_at t, user_elo e FROM games WHERE user_elo IS NOT NULL ORDER BY played_at")
    out = {"target": target, "tc": tc, "current": None, "eta_months": None, "slope_per_month": None}
    if not rows:
        return out
    out["current"] = rows[-1]["e"]
    out["start"] = rows[0]["e"]
    recent = [r for r in rows if r["t"] >= time.time() - 90 * 86400]
    if len(recent) >= 15:
        xs = [(r["t"] - recent[0]["t"]) / 86400 for r in recent]
        ys = [r["e"] for r in recent]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        den = sum((x - mx) ** 2 for x in xs)
        if den > 0:
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den * 30      # points per month
            out["slope_per_month"] = round(slope, 1)
            if slope > 1 and out["current"] < target:
                out["eta_months"] = round((target - out["current"]) / slope, 1)
    return out


def today_plan():
    s = db.get_settings()
    now = int(time.time())
    mid = _midnight()
    gp, gt = int(s.get("daily_goal_puzzles", 10)), int(s.get("daily_goal_tactics", 15))
    own_done = db.q1("SELECT COUNT(*) n FROM puzzle_attempts WHERE ts>=?", (mid,))["n"]
    own_due = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0 AND reps>0 AND due_at<=?", (now,))["n"]
    own_new = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0 AND reps=0 AND lapses=0")["n"]
    tac = tactics.stats() if tactics.available() else None
    rep_due = rep_new = 0
    rep_done = db.q1("SELECT COUNT(*) n FROM rep_progress WHERE last_ts>=?", (mid,))["n"]
    for r in repertoire.all_reps():
        cs = repertoire.card_stats(r)
        rep_due += cs["due"]
        rep_new += cs["new"]
    g = db.q1("""SELECT id, white, black, user_color, acc_white, acc_black FROM games
                 WHERE analyzed=1 AND user_color IS NOT NULL AND COALESCE(reviewed,0)=0 AND COALESCE(guided_done,0)=0
                 ORDER BY played_at DESC LIMIT 1""")
    review_done = _count_today("review")
    weak = None
    if tac and tac["themes"]:
        weak = tac["themes"][0]
    tasks = []
    tasks.append({"id": "puzzles", "icon": "🧩", "title": "Réviser mes erreurs",
                  "detail": f"{own_due} à réviser · {own_new} nouveaux" if (own_due or own_new) else "Aucun puzzle en attente",
                  "done": own_done, "goal": gp if (own_due or own_new) else 0, "link": "#/train?tab=mistakes", "minutes": 8})
    if tac and tac["available"]:
        tasks.append({"id": "tactics", "icon": "⚡", "title": "Tactiques classées",
                      "detail": f"Classement {tac['rating']}" + (f" · point faible : {weak['label']} ({weak['pct']}%)" if weak else ""),
                      "done": tac["today"], "goal": gt, "link": "#/train?tab=tactics", "minutes": 12})
    if g:
        tasks.append({"id": "review", "icon": "🔎", "title": "Revue guidée d'une partie",
                      "detail": f"{g['white']} – {g['black']}", "done": review_done, "goal": 1, "link": f"#/review/{g['id']}?guided=1", "minutes": 15})
    if rep_due or rep_new:
        tasks.append({"id": "rep", "icon": "🌳", "title": "Répertoire d'ouvertures",
                      "detail": f"{rep_due} positions à réviser · {rep_new} nouvelles", "done": rep_done, "goal": min(10, rep_due + rep_new), "link": "#/repertoire", "minutes": 8})
    tasks.append({"id": "calc", "icon": "🧮", "title": "Calcul : une ligne de 4 coups", "detail": "Trouve toute la ligne sans bouger les pièces",
                  "done": _count_today("calc"), "goal": 2, "link": "#/calcul", "minutes": 8})
    tasks.append({"id": "sparring", "icon": "⚔️", "title": "Sparring : rejouer un moment clé", "detail": "Une de tes erreurs ou un avantage à convertir, contre le moteur",
                  "done": _count_today("sparring"), "goal": 1, "link": "#/sparring", "minutes": 10})
    eg = db.q1("SELECT drill_id, attempts, successes, last_ts FROM endgame_progress ORDER BY successes*1.0/MAX(attempts,1), COALESCE(last_ts,0) LIMIT 1")
    tasks.append({"id": "endgame", "icon": "🏁", "title": "Une finale à maîtriser",
                  "detail": "Finales de base contre Stockfish", "done": _count_today("endgame"), "goal": 1, "link": "#/endgames", "minutes": 5})
    total = sum(1 for t in tasks if t["goal"])
    complete = sum(1 for t in tasks if t["goal"] and t["done"] >= t["goal"])
    return {"tasks": tasks, "complete": complete, "total": total, "streak": streak(),
            "minutes": sum(t["minutes"] for t in tasks if t["goal"] and t["done"] < t["goal"]),
            "progress": rating_progress("rapid")}
