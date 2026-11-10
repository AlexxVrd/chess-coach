"""Positions de départ pour jouer contre le moteur : tes erreurs, tes avantages gâchés, ton répertoire."""
import random

import chess

from . import db, repertoire

KINDS = ("critical", "convert", "opening", "free")


def _pov(row):
    return row["eval_before"] if row["color"] == "w" else -row["eval_before"]


def pick(kind: str, exclude: str | None = None):
    if kind == "critical":
        rows = db.q("""SELECT p.fen, p.side, p.phase, p.played_san, p.solution_san, p.loss, g.white, g.black, g.id gid
                       FROM puzzles p JOIN games g ON g.id=p.game_id WHERE p.suspended=0 ORDER BY RANDOM() LIMIT 30""")
        rows = [r for r in rows if r["fen"] != exclude]
        if not rows:
            return None
        r = random.choice(rows)
        color = r["fen"].split()[1]
        return {"kind": kind, "fen": r["fen"], "color": color, "title": "Une de tes erreurs, rejouée",
                "tip": f"Dans ta partie contre {r['black'] if color == 'w' else r['white']} tu as joué {r['played_san']} ici. Trouve mieux et joue la suite contre le moteur.",
                "game_id": r["gid"]}
    if kind == "convert":
        base = """SELECT m.fen_before fen, m.color, m.eval_before, m.phase, g.user_result, g.id gid, g.white, g.black
                  FROM moves m JOIN games g ON g.id=m.game_id
                  WHERE g.user_color=m.color AND m.is_book=0 AND m.phase!='opening' AND m.mate_before IS NULL
                    AND ((m.color='w' AND m.eval_before BETWEEN 250 AND 900) OR (m.color='b' AND m.eval_before BETWEEN -900 AND -250))
                    {extra} ORDER BY RANDOM() LIMIT 40"""
        rows = db.q(base.format(extra="AND g.user_result!='win'")) or db.q(base.format(extra=""))
        rows = [r for r in rows if r["fen"] != exclude]
        if not rows:
            return None
        r = random.choice(rows)
        return {"kind": kind, "fen": r["fen"], "color": r["color"], "title": "Convertir un avantage",
                "tip": "Tu avais un net avantage dans cette partie" + (" mais tu ne l'as pas gagnée" if r["user_result"] != "win" else "") +
                       ". Simplifie, évite les pièges, et conclus proprement.", "game_id": r["gid"]}
    if kind == "opening":
        reps = [r for r in repertoire.all_reps() if len(r.nodes) > 12]
        random.shuffle(reps)
        for rep in reps:
            cands = [n for n in rep.nodes if rep.our_turn(n) and n.next and 5 <= len(n.path) <= 14 and n.fen != exclude]
            if cands:
                n = random.choice(cands)
                return {"kind": kind, "fen": n.fen, "color": rep.color, "title": f"Répertoire : {rep.title}",
                        "tip": "Sors de la théorie avec le plan de ton répertoire, puis joue la partie contre le moteur.",
                        "opening": " ".join(x.san for x in n.path)}
        return None
    return {"kind": "free", "fen": chess.STARTING_FEN, "color": "w", "title": "Partie libre", "tip": "Partie complète contre le moteur, à ton rythme."}
