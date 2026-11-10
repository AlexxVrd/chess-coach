"""Habitudes de jeu : gestion du temps et « tilt » (séries de défaites, séances trop longues, heures)."""
import time
from datetime import datetime

from . import db

SESSION_GAP = 45 * 60          # plus de 45 min sans jouer = nouvelle séance


def _base_seconds(tc: str):
    try:
        base = (tc or "").split("+")[0]
        if "/" in base:
            return None
        return int(base)
    except ValueError:
        return None


def _score(rows):
    n = len(rows)
    if not n:
        return None
    s = sum(1.0 if r["user_result"] == "win" else 0.5 if r["user_result"] == "draw" else 0.0 for r in rows)
    return round(100 * s / n)


def _bucket(rows):
    return {"n": len(rows), "score": _score(rows)}


def tilt(days=None, tc=None):
    w, a = ["user_color IS NOT NULL", "user_result IS NOT NULL"], []
    if days:
        w.append("played_at>=?"); a.append(int(time.time() - int(days) * 86400))
    if tc and tc != "all":
        w.append("time_class=?"); a.append(tc)
    games = db.q(f"SELECT id, played_at, user_result, time_class, user_elo FROM games WHERE {' AND '.join(w)} ORDER BY played_at", a)
    sessions, cur = [], []
    for g in games:
        if cur and g["played_at"] - cur[-1]["played_at"] > SESSION_GAP:
            sessions.append(cur); cur = []
        cur.append(g)
    if cur:
        sessions.append(cur)
    after = {"start": [], "win": [], "loss": [], "loss2": [], "loss3": []}
    by_idx = {1: [], 2: [], 3: [], 4: [], 5: []}
    for s in sessions:
        streak = 0
        for i, g in enumerate(s):
            by_idx[min(i + 1, 5)].append(g)
            if i == 0:
                after["start"].append(g)
            else:
                prev = s[i - 1]["user_result"]
                after["win" if prev == "win" else "loss" if prev == "loss" else "start"].append(g) if prev != "draw" else None
                if streak >= 3:
                    after["loss3"].append(g)
                if streak >= 2:
                    after["loss2"].append(g)
            streak = streak + 1 if g["user_result"] == "loss" else 0
    hours = {"matin (6-12h)": [], "après-midi (12-18h)": [], "soir (18-23h)": [], "nuit (23-6h)": []}
    for g in games:
        hh = datetime.fromtimestamp(g["played_at"]).hour
        k = "matin (6-12h)" if 6 <= hh < 12 else "après-midi (12-18h)" if 12 <= hh < 18 else "soir (18-23h)" if 18 <= hh < 23 else "nuit (23-6h)"
        hours[k].append(g)
    out = {
        "games": len(games), "sessions": len(sessions),
        "avg_session": round(len(games) / len(sessions), 1) if sessions else 0,
        "baseline": _score(games),
        "after": {k: _bucket(v) for k, v in after.items()},
        "by_index": {str(k): _bucket(v) for k, v in by_idx.items()},
        "by_hour": {k: _bucket(v) for k, v in hours.items()},
    }
    advice = []
    base = out["baseline"]
    a2 = out["after"]["loss2"]
    if a2["n"] >= 8 and base is not None and a2["score"] is not None and a2["score"] <= base - 8:
        advice.append({"kind": "tilt", "text": f"Après 2 défaites d'affilée tu ne marques que {a2['score']} % (contre {base} % en moyenne, {a2['n']} parties). "
                                                "Règle simple : 2 défaites = pause de 20 minutes ou fin de séance."})
    a1, st = out["after"]["loss"], out["after"]["start"]
    if a1["n"] >= 20 and st["score"] is not None and a1["score"] is not None and a1["score"] <= st["score"] - 8:
        advice.append({"kind": "tilt1", "text": f"Juste après une défaite tu marques {a1['score']} % ({a1['n']} parties), contre {st['score']} % en début de séance. "
                                                 "Respire 5 minutes (ou fais 3 puzzles) avant de relancer une partie."})
    late, early = out["by_index"]["5"], out["by_index"]["1"]
    if late["n"] >= 8 and early["n"] >= 8 and late["score"] is not None and early["score"] is not None and late["score"] <= early["score"] - 10:
        advice.append({"kind": "fatigue", "text": f"Tu perds en fraîcheur : {early['score']} % sur la 1re partie d'une séance, {late['score']} % à partir de la 5e. Limite-toi à 3–4 parties par séance."})
    hv = [(k, v) for k, v in out["by_hour"].items() if v["n"] >= 10 and v["score"] is not None]
    if len(hv) >= 2:
        best, worst = max(hv, key=lambda x: x[1]["score"]), min(hv, key=lambda x: x[1]["score"])
        if best[1]["score"] - worst[1]["score"] >= 12:
            advice.append({"kind": "hour", "text": f"Tes meilleurs résultats : {best[0]} ({best[1]['score']} %), les pires : {worst[0]} ({worst[1]['score']} %). Joue tes parties sérieuses au bon moment."})
    out["advice"] = advice
    return out


def time_stats(days=None, tc=None):
    w, a = ["g.user_color IS NOT NULL", "g.analyzed=1", "m.color=g.user_color", "m.is_book=0"], []
    if days:
        w.append("g.played_at>=?"); a.append(int(time.time() - int(days) * 86400))
    if tc and tc != "all":
        w.append("g.time_class=?"); a.append(tc)
    rows = db.q(f"""SELECT g.id gid, g.time_control tcs, g.user_result res, g.termination term, m.ply, m.phase, m.cls, m.loss,
                           m.clock_ms, m.spent_ms FROM moves m JOIN games g ON g.id=m.game_id WHERE {' AND '.join(w)}""", a)
    if not rows:
        return {"moves": 0}
    bad = {"mistake", "blunder"}
    # 1) moves played fast vs slow
    buckets = [("< 2 s", 0, 2), ("2–5 s", 2, 5), ("5–15 s", 5, 15), ("15–40 s", 15, 40), ("> 40 s", 40, 10**9)]
    spent = []
    for name, lo, hi in buckets:
        sel = [r for r in rows if r["spent_ms"] is not None and lo <= r["spent_ms"] / 1000 < hi]
        spent.append({"label": name, "n": len(sel), "err_pct": round(100 * sum(1 for r in sel if r["cls"] in bad) / len(sel), 1) if len(sel) >= 15 else None})
    # 2) time pressure (clock < 10 % of base time)
    low = []
    ok = []
    for r in rows:
        base = _base_seconds(r["tcs"])
        if base and r["clock_ms"] is not None:
            (low if r["clock_ms"] / 1000 < 0.1 * base else ok).append(r)
    pressure = {
        "low_n": len(low), "ok_n": len(ok),
        "low_err_pct": round(100 * sum(1 for r in low if r["cls"] in bad) / len(low), 1) if len(low) >= 15 else None,
        "ok_err_pct": round(100 * sum(1 for r in ok if r["cls"] in bad) / len(ok), 1) if len(ok) >= 15 else None,
    }
    # 3) time per phase
    phase = {}
    for p in ("opening", "middlegame", "endgame"):
        sel = [r["spent_ms"] for r in rows if r["phase"] == p and r["spent_ms"] is not None]
        phase[p] = round(sum(sel) / len(sel) / 1000, 1) if len(sel) >= 10 else None
    # 4) games ended in time trouble / lost on time
    games = {}
    for r in rows:
        g = games.setdefault(r["gid"], {"res": r["res"], "term": r["term"], "tc": r["tcs"], "last": None})
        if r["clock_ms"] is not None:
            g["last"] = r["clock_ms"]
    losses = [g for g in games.values() if g["res"] == "loss"]
    timeouts = [g for g in losses if "time" in (g["term"] or "").lower()]
    trouble = []
    for g in games.values():
        base = _base_seconds(g["tc"])
        if base and g["last"] is not None and g["last"] / 1000 < 0.07 * base:
            trouble.append(g)
    # 5) overthinking : positions where a lot of time was spent with a bad result
    thinkers = [r for r in rows if r["spent_ms"] and r["clock_ms"] is not None]
    out = {
        "moves": len(rows), "spent": spent, "pressure": pressure, "phase_avg_s": phase,
        "losses": len(losses), "timeouts": len(timeouts),
        "trouble_games": len(trouble), "trouble_score": _score([{"user_result": g["res"]} for g in trouble]) if len(trouble) >= 5 else None,
        "games": len(games),
    }
    advice = []
    fast, slow = spent[0], spent[2]
    if fast["err_pct"] is not None and slow["err_pct"] is not None and fast["err_pct"] >= slow["err_pct"] + 4:
        advice.append({"kind": "fast", "text": f"Les coups joués en moins de 2 s sont des erreurs/gaffes dans {fast['err_pct']} % des cas, contre {slow['err_pct']} % quand tu réfléchis 5–15 s. "
                                                "Avant chaque coup non forcé : « Que menace mon adversaire ? »."})
    if pressure["low_err_pct"] is not None and pressure["ok_err_pct"] is not None and pressure["low_err_pct"] >= pressure["ok_err_pct"] + 5:
        advice.append({"kind": "pressure", "text": f"Au zeitnot (<10 % du temps) tes erreurs montent à {pressure['low_err_pct']} % des coups (contre {pressure['ok_err_pct']} %). "
                                                   "Joue plus vite en ouverture (théorie) pour garder du temps en milieu de partie."})
    if losses and len(timeouts) / len(losses) >= 0.2:
        advice.append({"kind": "flag", "text": f"{len(timeouts)} de tes {len(losses)} défaites analysées sont au temps. Une cadence plus longue, ou moins de temps passé sur les premiers coups, aide directement."})
    if out["trouble_score"] is not None:
        advice.append({"kind": "trouble", "text": f"Tu finis {len(trouble)} parties avec presque plus de temps : score {out['trouble_score']} % dans ces parties."})
    ph = phase
    if ph["opening"] and ph["middlegame"] and ph["opening"] > 1.3 * ph["middlegame"]:
        advice.append({"kind": "opening", "text": f"Tu passes {ph['opening']} s par coup en ouverture contre {ph['middlegame']} s en milieu de partie : investis ton temps là où la partie se décide."})
    out["advice"] = advice
    return out


def overview(days=None, tc=None):
    return {"tilt": tilt(days, tc), "time": time_stats(days, tc)}
