"""Aggregated statistics, opening explorer, coach summaries and the personalised training plan."""
import json
import re
import time
from collections import defaultdict

from . import db, repertoire
from .analyzer import winprob


def _where(tc=None, days=None, color=None, extra=""):
    w, a = ["g.user_color IS NOT NULL"], []
    if tc and tc != "all":
        w.append("g.time_class=?")
        a.append(tc)
    if days:
        w.append("g.played_at>=?")
        a.append(int(time.time() - int(days) * 86400))
    if color in ("w", "b"):
        w.append("g.user_color=?")
        a.append(color)
    if extra:
        w.append(extra)
    return " AND ".join(w), a


def termination_kind(term: str, user_result: str, user_color: str) -> str:
    t = (term or "").lower()
    if "time" in t:
        return "time"
    if "checkmate" in t or "mate" in t:
        return "mate"
    if "resign" in t:
        return "resign"
    if "abandon" in t:
        return "abandon"
    if "repetition" in t or "agreement" in t or "stalemate" in t or "insufficient" in t or "50" in t:
        return "draw"
    return "other"


def wdl(rows):
    w = sum(1 for r in rows if r["user_result"] == "win")
    d = sum(1 for r in rows if r["user_result"] == "draw")
    l = sum(1 for r in rows if r["user_result"] == "loss")
    n = w + d + l
    return {"games": n, "win": w, "draw": d, "loss": l, "score": round(100 * (w + 0.5 * d) / n, 1) if n else None}


# ------------------------------------------------------------------ overview
def overview(tc=None, days=None):
    where, args = _where(tc, days)
    games = db.q(f"SELECT g.* FROM games g WHERE {where} ORDER BY g.played_at", args)
    out = {"filters": {"tc": tc or "all", "days": days}}
    out["totals"] = {
        "all": wdl(games),
        "white": wdl([g for g in games if g["user_color"] == "w"]),
        "black": wdl([g for g in games if g["user_color"] == "b"]),
        "analyzed": sum(1 for g in games if g["analyzed"]),
    }
    # ratings per time class
    ratings = defaultdict(list)
    for g in games:
        if g["user_elo"]:
            ratings[g["time_class"]].append([g["played_at"], g["user_elo"]])
    out["ratings"] = ratings
    out["rating_now"] = {k: v[-1][1] for k, v in ratings.items()}
    out["rating_peak"] = {k: max(x[1] for x in v) for k, v in ratings.items()}

    # termination breakdown
    losses, wins = defaultdict(int), defaultdict(int)
    for g in games:
        k = termination_kind(g["termination"], g["user_result"], g["user_color"])
        if g["user_result"] == "loss":
            losses[k] += 1
        elif g["user_result"] == "win":
            wins[k] += 1
    out["loss_by"] = losses
    out["win_by"] = wins

    # opponent strength buckets
    buckets = defaultdict(list)
    for g in games:
        if g["user_elo"] and g["opp_elo"]:
            d = g["opp_elo"] - g["user_elo"]
            key = "much_weaker" if d < -100 else "weaker" if d < -30 else "equal" if d <= 30 else "stronger" if d <= 100 else "much_stronger"
            buckets[key].append(g)
    out["by_opponent"] = {k: wdl(v) for k, v in buckets.items()}

    # ---- analysis-based stats (user's own moves only)
    ids = [g["id"] for g in games if g["analyzed"]]
    out["analysis"] = analysis_stats(games, ids)
    out["plan"] = build_plan(out, games)
    return out


def analysis_stats(games, ids):
    res = {"games": len(ids)}
    if not ids:
        return res
    by_id = {g["id"]: g for g in games}
    ph = ",".join("?" * len(ids))
    rows = db.q(
        f"""SELECT m.game_id, m.ply, m.color, m.cls, m.loss, m.accuracy, m.phase, m.tags, m.spent_ms, m.clock_ms,
                   m.eval_before, m.eval_after, m.is_book
            FROM moves m WHERE m.game_id IN ({ph}) AND m.cls IS NOT NULL ORDER BY m.game_id, m.ply""", ids)
    per_game = defaultdict(list)
    for r in rows:
        per_game[r["game_id"]].append(r)

    phase = defaultdict(lambda: {"n": 0, "acc": 0.0, "loss": 0.0, "blunders": 0, "mistakes": 0, "inacc": 0})
    cls = defaultdict(int)
    tags = defaultdict(int)
    acc_series, spent_by_phase = [], defaultdict(list)
    fast_moves = fast_bad = 0
    tt_blunders = tt_total = 0
    conv_reached = conv_won = res_reached = res_saved = 0
    first_error_ply = []
    blunders_total = 0
    for gid, mv in per_game.items():
        g = by_id[gid]
        uc = g["user_color"]
        mine = [m for m in mv if m["color"] == uc and not m["is_book"]]
        for m in mine:
            p = phase[m["phase"]]
            p["n"] += 1
            p["acc"] += m["accuracy"] or 0
            p["loss"] += m["loss"] or 0
            if m["cls"] == "blunder":
                p["blunders"] += 1
                blunders_total += 1
            elif m["cls"] == "mistake":
                p["mistakes"] += 1
            elif m["cls"] == "inaccuracy":
                p["inacc"] += 1
            cls[m["cls"]] += 1
            for t in json.loads(m["tags"] or "[]"):
                tags[t] += 1
            if m["spent_ms"] is not None:
                spent_by_phase[m["phase"]].append(m["spent_ms"] / 1000)
                if m["spent_ms"] < 3000 and m["ply"] > 12:
                    fast_moves += 1
                    if m["cls"] in ("mistake", "blunder"):
                        fast_bad += 1
            if m["clock_ms"] is not None and m["clock_ms"] < 60000:
                tt_total += 1
                if m["cls"] == "blunder":
                    tt_blunders += 1
        acc = g["acc_white"] if uc == "w" else g["acc_black"]
        if acc is not None:
            acc_series.append([g["played_at"], acc, gid, g["user_result"]])
        errs = [m["ply"] for m in mine if m["cls"] in ("mistake", "blunder")]
        if errs:
            first_error_ply.append((errs[0] + 1) // 2)
        # conversion / resilience: user win% over the game
        wps = [winprob(m["eval_after"] if uc == "w" else -m["eval_after"]) for m in mv if m["eval_after"] is not None]
        if wps:
            if max(wps) >= 80:
                conv_reached += 1
                conv_won += g["user_result"] == "win"
            if min(wps) <= 20:
                res_reached += 1
                res_saved += g["user_result"] in ("win", "draw")

    n_games = len(per_game)
    res["phase"] = {
        k: {"moves": v["n"], "accuracy": round(v["acc"] / v["n"], 1) if v["n"] else None,
            "avg_loss": round(v["loss"] / v["n"], 2) if v["n"] else None,
            "blunders_per_game": round(v["blunders"] / n_games, 2), "mistakes_per_game": round(v["mistakes"] / n_games, 2),
            "inaccuracies_per_game": round(v["inacc"] / n_games, 2)} for k, v in phase.items()}
    res["per_game"] = {k: round(cls[k] / n_games, 2) for k in ("brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "blunder")}
    res["tags"] = sorted(({"tag": k, "count": v, "per_game": round(v / n_games, 2)} for k, v in tags.items()), key=lambda x: -x["count"])
    res["accuracy_series"] = acc_series
    res["avg_accuracy"] = round(sum(a[1] for a in acc_series) / len(acc_series), 1) if acc_series else None
    res["time"] = {
        "avg_spent": {k: round(sum(v) / len(v), 1) for k, v in spent_by_phase.items() if v},
        "fast_moves": fast_moves, "fast_bad_pct": round(100 * fast_bad / fast_moves, 1) if fast_moves else None,
        "low_clock_moves": tt_total, "low_clock_blunders": tt_blunders,
        "low_clock_blunder_pct": round(100 * tt_blunders / tt_total, 1) if tt_total else None,
    }
    res["conversion"] = {"reached": conv_reached, "won": conv_won,
                         "pct": round(100 * conv_won / conv_reached, 1) if conv_reached else None}
    res["resilience"] = {"reached": res_reached, "saved": res_saved,
                         "pct": round(100 * res_saved / res_reached, 1) if res_reached else None}
    res["avg_first_error_move"] = round(sum(first_error_ply) / len(first_error_ply), 1) if first_error_ply else None
    res["blunders_per_game"] = round(blunders_total / n_games, 2)
    return res


# ------------------------------------------------------------------ training plan
TAG_ADVICE = {
    "hung_piece": ("Pièces laissées en prise", "Avant chaque coup : « qu'est-ce que mon adversaire peut prendre ou menacer après ce coup ? ». Fais les puzzles tagués « pièce en prise »."),
    "missed_material": ("Gains de matériel manqués", "Tu rates des captures gagnantes. Avant de jouer, liste toutes les captures et les échecs disponibles pour toi."),
    "missed_fork": ("Fourchettes manquées", "Travaille les motifs de fourchette (cavalier surtout) dans l'entraînement tactique."),
    "allowed_fork": ("Fourchettes autorisées", "Avant de poser une pièce, regarde les cases d'où un cavalier/pion adverse pourrait fourcher."),
    "mate_missed": ("Mats manqués", "Cherche systématiquement les échecs et les captures qui forcent : les mats en 1–3 coups doivent devenir un réflexe."),
    "mate_allowed": ("Mats autorisés", "Vérifie la sécurité de ton roi et les échecs adverses avant chaque coup non forcé."),
    "threw_advantage": ("Avantage gâché", "Dans les positions gagnantes, simplifie et joue le coup le plus sûr plutôt que le plus ambitieux."),
    "missed_opportunity": ("Fautes adverses non punies", "Après un coup adverse inattendu, prends le temps de chercher ce qu'il vient de laisser (menace, pièce non protégée)."),
    "time_trouble": ("Erreurs en zeitnot", "Gère mieux ton temps : économise-le dans l'ouverture (théorie connue) pour le garder aux moments critiques."),
    "too_fast": ("Gaffes jouées trop vite", "Impose-toi une pause de 5 secondes avant chaque coup non évident : « menaces adverses ? »."),
}


def build_plan(ov, games):
    plan = []
    a = ov.get("analysis", {})
    T = ov["totals"]["all"]
    if T["games"] < 5:
        return [{"priority": 1, "title": "Importe plus de parties", "detail": "Il faut au moins ~20 parties pour des statistiques fiables.", "link": "#/settings"}]
    if a.get("games", 0) < max(3, T["games"] * 0.3):
        plan.append({"priority": 0, "title": "Analyse tes parties", "detail": f"Seulement {a.get('games', 0)} parties analysées sur {T['games']}. Lance l'analyse pour débloquer le coaching.", "link": "#/games"})
        if not a.get("games"):
            return plan
    bpg = a.get("blunders_per_game", 0)
    if bpg > 0.6:
        plan.append({"priority": 1, "title": f"Réduire les gaffes ({bpg}/partie)",
                     "detail": "C'est LE levier n°1 entre 1300 et 1800 : la plupart des parties se décident sur une gaffe. Objectif : < 0,5 par partie. Fais les puzzles issus de TES erreurs chaque jour.",
                     "link": "#/train"})
    ph = a.get("phase", {})
    worst = sorted(((k, v) for k, v in ph.items() if v["accuracy"] is not None and v["moves"] > 30), key=lambda kv: kv[1]["accuracy"])
    names = {"opening": "l'ouverture", "middlegame": "le milieu de partie", "endgame": "la finale"}
    if worst:
        k, v = worst[0]
        plan.append({"priority": 2, "title": f"Point faible : {names.get(k, k)} (précision {v['accuracy']}%)",
                     "detail": f"C'est ta phase la moins précise ({v['avg_loss']} de perte de win% par coup en moyenne)." +
                               (" Travaille les finales de base (Lucena, Philidor, opposition)." if k == "endgame" else
                                " Construis un répertoire plus solide et vérifie-le dans l'explorateur." if k == "opening" else
                                " Pense en plans : pièces mal placées, cases faibles, tactiques avant chaque coup."),
                     "link": "#/endgames" if k == "endgame" else "#/openings" if k == "opening" else "#/train"})
    for t in a.get("tags", [])[:3]:
        if t["tag"] in TAG_ADVICE and t["per_game"] >= 0.15:
            title, adv = TAG_ADVICE[t["tag"]]
            plan.append({"priority": 3, "title": f"{title} ({t['count']}×)", "detail": adv, "link": "#/train"})
    tm = a.get("time", {})
    if tm.get("fast_moves", 0) >= 20 and (tm.get("fast_bad_pct") or 0) >= 8:
        plan.append({"priority": 3, "title": "Tu joues trop vite sur certains coups",
                     "detail": f"{tm['fast_bad_pct']}% de tes coups joués en moins de 3 s (hors ouverture) sont des erreurs/gaffes. Utilise ton temps : en rapide, tu en as.",
                     "link": "#/stats"})
    if (ov["loss_by"].get("time", 0) >= 3) and ov["totals"]["all"]["loss"]:
        pct = round(100 * ov["loss_by"]["time"] / ov["totals"]["all"]["loss"])
        if pct >= 12:
            plan.append({"priority": 3, "title": f"{pct}% de tes défaites sont au temps",
                         "detail": "Joue plus vite l'ouverture et les coups évidents, et évite les longues réflexions dans les positions sans enjeu.", "link": "#/stats"})
    c = a.get("conversion", {})
    if c.get("reached", 0) >= 5 and (c.get("pct") or 100) < 75:
        plan.append({"priority": 2, "title": f"Conversion des avantages : {c['pct']}%",
                     "detail": f"Sur {c['reached']} parties où tu étais largement gagnant, tu n'en as gagné que {c['won']}. Entraîne-toi à convertir : finales gagnantes contre Stockfish dans « Finales ».",
                     "link": "#/endgames"})
    r = a.get("resilience", {})
    if r.get("reached", 0) >= 5 and (r.get("pct") or 0) < 15:
        plan.append({"priority": 4, "title": "Résilience",
                     "detail": f"Tu sauves seulement {r['pct']}% des positions très difficiles : complique, cherche les pièges et le pat plutôt que d'abandonner mentalement.", "link": "#/review"})
    # openings
    ops = opening_table(ov["filters"]["tc"], ov["filters"]["days"])
    bad = [o for o in ops if o["games"] >= 4 and o["score"] is not None and o["score"] < 35]
    if bad:
        o = sorted(bad, key=lambda x: -x["games"])[0]
        plan.append({"priority": 3, "title": f"Ouverture à revoir : {o['opening']} ({'blancs' if o['color']=='w' else 'noirs'})",
                     "detail": f"{o['games']} parties, score {o['score']}%. Regarde où tu sors de la théorie et ce que jouent tes adversaires.", "link": "#/openings"})
    now = int(time.time())
    due = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0 AND reps>0 AND due_at<=?", (now,))["n"]
    fresh = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0 AND reps=0 AND lapses=0")["n"]
    if due:
        plan.append({"priority": 1, "title": f"{due} puzzles à réviser aujourd'hui", "detail": "La répétition espacée sur tes propres erreurs est le moyen le plus rapide de ne plus les refaire.", "link": "#/train"})
    elif fresh:
        plan.append({"priority": 2, "title": f"{fresh} nouveaux puzzles tirés de tes erreurs", "detail": "Chaque gaffe de tes parties analysées est devenue un exercice. Vise 10 à 15 puzzles par jour.", "link": "#/train"})
    rep_due = [(r.title, repertoire.card_stats(r)["due"]) for r in repertoire.all_reps()]
    rep_due = [(t, n) for t, n in rep_due if n]
    if rep_due:
        plan.append({"priority": 2, "title": f"{sum(n for _, n in rep_due)} positions d'ouverture à réviser",
                     "detail": " · ".join(f"{t} : {n}" for t, n in rep_due) + ". Quelques minutes suffisent pour ne plus sortir de ta préparation.",
                     "link": "#/repertoire"})
    plan.sort(key=lambda p: p["priority"])
    return plan


# ------------------------------------------------------------------ openings
def opening_table(tc=None, days=None, color=None):
    where, args = _where(tc, days, color, "g.opening IS NOT NULL")
    rows = db.q(f"SELECT g.* FROM games g WHERE {where}", args)
    groups = defaultdict(list)
    for g in rows:
        base = g["opening"].split(":")[0]
        groups[(base, g["user_color"])].append(g)
    out = []
    for (name, col), gs in groups.items():
        r = wdl(gs)
        accs = [g["acc_white"] if col == "w" else g["acc_black"] for g in gs if g["analyzed"]]
        accs = [a for a in accs if a is not None]
        out.append({"opening": name, "eco": gs[0]["eco"], "color": col, **r,
                    "avg_accuracy": round(sum(accs) / len(accs), 1) if accs else None,
                    "avg_book": round(sum(g["book_plies"] for g in gs) / len(gs) / 2, 1)})
    out.sort(key=lambda x: -x["games"])
    return out


def explorer(fenkey: str, color: str, tc=None, days=None):
    """Own-games explorer: what was played from this position, with results and engine loss."""
    where, args = _where(tc, days, color)
    rows = db.q(
        f"""SELECT m.uci, m.san, m.color, COUNT(*) n,
                   SUM(g.user_result='win') w, SUM(g.user_result='draw') d, SUM(g.user_result='loss') l,
                   AVG(m.loss) avg_loss, MAX(m.best_san) best_san, AVG(m.eval_before) ev,
                   SUM(m.cls IN ('mistake','blunder')) errors, SUM(m.cls IS NOT NULL) analysed
            FROM moves m JOIN games g ON g.id=m.game_id
            WHERE m.fenkey=? AND {where} GROUP BY m.uci ORDER BY n DESC""", [fenkey] + args)
    total = sum(r["n"] for r in rows) or 1
    for r in rows:
        r["pct"] = round(100 * r["n"] / total, 1)
        r["score"] = round(100 * ((r["w"] or 0) + 0.5 * (r["d"] or 0)) / r["n"], 1)
        r["avg_loss"] = round(r["avg_loss"], 1) if r["avg_loss"] is not None else None
    side = fenkey.split()[1]
    return {"fenkey": fenkey, "side_to_move": side, "mine": side == color, "moves": rows, "total": total}


def opening_leaks(color=None, tc=None, days=None, limit=15):
    """Positions in the opening phase where the user most often makes a costly move (needs analysed games)."""
    where, args = _where(tc, days, color, "m.color=g.user_color AND m.phase='opening' AND m.is_book=0 AND m.loss IS NOT NULL")
    rows = db.q(
        f"""SELECT m.fenkey, m.fen_before, m.san, m.best_san, COUNT(*) n, AVG(m.loss) avg_loss, g.user_color color,
                   SUM(g.user_result='win') w, SUM(g.user_result='loss') l
            FROM moves m JOIN games g ON g.id=m.game_id WHERE {where}
            GROUP BY m.fenkey, m.uci HAVING n>=2 AND avg_loss>=8 ORDER BY n*avg_loss DESC LIMIT ?""", args + [limit])
    return rows


# ------------------------------------------------------------------ games
def list_games(tc=None, days=None, color=None, result=None, opening=None, q=None, analyzed=None, starred=None, limit=50, offset=0):
    extra = []
    args_extra = []
    if result in ("win", "draw", "loss"):
        extra.append("g.user_result=?"); args_extra.append(result)
    if opening:
        extra.append("g.opening LIKE ?"); args_extra.append(opening + "%")
    if q:
        extra.append("(g.white LIKE ? OR g.black LIKE ?)"); args_extra += [f"%{q}%", f"%{q}%"]
    if analyzed in (0, 1):
        extra.append("g.analyzed=?"); args_extra.append(analyzed)
    if starred:
        extra.append("g.starred=1")
    where, args = _where(tc, days, color, " AND ".join(extra))
    # include games with unknown user too when no user filter is meaningful
    total = db.q1(f"SELECT COUNT(*) n FROM games g WHERE {where}", args + args_extra)["n"]
    rows = db.q(
        f"""SELECT g.id, g.source, g.url, g.white, g.black, g.white_elo, g.black_elo, g.result, g.time_class, g.time_control,
                   g.played_at, g.user_color, g.user_result, g.eco, g.opening, g.plies, g.analyzed, g.acc_white, g.acc_black,
                   g.starred, g.reviewed, g.termination,
                   (SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id AND m.color=g.user_color AND m.cls='blunder') blunders,
                   (SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id AND m.color=g.user_color AND m.cls='mistake') mistakes
            FROM games g WHERE {where} ORDER BY g.played_at DESC LIMIT ? OFFSET ?""", args + args_extra + [limit, offset])
    return {"total": total, "games": rows}


def game_detail(gid: int):
    g = db.q1("SELECT * FROM games WHERE id=?", (gid,))
    if not g:
        return None
    moves = db.q("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (gid,))
    for m in moves:
        m["tags"] = json.loads(m["tags"] or "[]")
    g["moves"] = moves
    g["coach"] = coach_summary(g, moves) if g["analyzed"] else None
    return g


PHASE_FR = {"opening": "l'ouverture", "middlegame": "le milieu de partie", "endgame": "la finale"}


def coach_summary(g, moves):
    """Rule-based French summary: accuracy by phase, turning points, recurring issues."""
    uc = g["user_color"] or "w"
    mine = [m for m in moves if m["color"] == uc and m["cls"] and not m["is_book"]]
    sign = 1 if uc == "w" else -1
    out = {"user_color": uc}
    ph = defaultdict(list)
    for m in mine:
        ph[m["phase"]].append(m)
    out["phases"] = {k: {"moves": len(v), "accuracy": round(sum(x["accuracy"] for x in v) / len(v), 1),
                         "errors": sum(1 for x in v if x["cls"] in ("mistake", "blunder"))} for k, v in ph.items()}
    # turning points = biggest swings against the user (and missed chances)
    swings = sorted(mine, key=lambda m: -(m["loss"] or 0))[:4]
    out["key_moments"] = [{"ply": m["ply"], "san": m["san"], "best": m["best_san"], "loss": m["loss"], "cls": m["cls"], "tags": m["tags"]}
                          for m in swings if (m["loss"] or 0) >= 10]
    lines = []
    if g["opening"]:
        lines.append(f"Ouverture : {g['opening']} ({g['eco']}). Tu es resté dans la théorie jusqu'au coup {(g['book_plies'] + 1) // 2}.")
    errs = [m for m in mine if m["cls"] in ("mistake", "blunder")]
    if not errs:
        lines.append("Partie très propre : aucune erreur ni gaffe détectée. 👏")
    else:
        first = errs[0]
        lines.append(f"Première erreur significative au coup {(first['ply'] + 1) // 2} ({first['san']}, meilleur : {first['best_san']}).")
    worst = sorted(out["phases"].items(), key=lambda kv: kv[1]["accuracy"])
    if worst and len(worst) > 1:
        lines.append(f"Phase la plus faible : {PHASE_FR.get(worst[0][0], worst[0][0])} ({worst[0][1]['accuracy']}% de précision).")
    wps = [winprob(sign * m["eval_after"]) for m in moves if m["eval_after"] is not None]
    if wps and max(wps) >= 80 and g["user_result"] != "win":
        lines.append("Tu avais une position gagnante à un moment : c'est une partie à étudier en priorité (conversion).")
    if wps and min(wps) <= 20 and g["user_result"] in ("win", "draw"):
        lines.append("Belle résilience : tu as sauvé une position difficile.")
    tagc = defaultdict(int)
    for m in mine:
        for t in m["tags"] if isinstance(m["tags"], list) else json.loads(m["tags"] or "[]"):
            tagc[t] += 1
    if tagc:
        t = max(tagc, key=tagc.get)
        if t in TAG_ADVICE:
            lines.append(f"Motif récurrent : {TAG_ADVICE[t][0].lower()}. {TAG_ADVICE[t][1]}")
    out["lines"] = lines
    return out
