"""Opening repertoires: decision trees read from PGN files (data/repertoires/*.pgn), checked against the
user's games, annotated by Stockfish and drilled with spaced repetition.

A repertoire PGN is a normal PGN with variations: at the user's turn the main move is the repertoire move,
at the opponent's turn every variation is a reply we are prepared for. Header [Color "White"|"Black"] tells
which side the user plays; [Description "..."] is shown in the UI. Lichess studies export exactly this format.
"""
import json
import random
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import chess
import chess.pgn

from . import db, openings, training
from .analyzer import winprob

REP_DIR = db.DATA / "repertoires"
NAG_SYM = {1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!"}
EVAL_DEPTH = 16
LEARNED_DAYS = 21


@dataclass(eq=False)
class Node:
    """One position of the tree, reached by `san` (None for the starting position)."""
    id: int
    parent: "Node | None"
    san: str | None
    uci: str | None
    fen: str
    fenkey: str
    ours: bool                  # the move leading here was played by the repertoire side
    alt: bool = False           # an accepted alternative to the main repertoire move (a leaf)
    comment: str = ""
    nag: str = ""
    children: list = field(default_factory=list)
    transpose: "Node | None" = None   # leaf whose position is continued elsewhere in the tree

    @property
    def next(self) -> list:
        """Moves available from this position, following a transposition."""
        return self.children or (self.transpose.children if self.transpose else [])

    @property
    def path(self) -> list:
        out, n = [], self
        while n.parent is not None:
            out.append(n)
            n = n.parent
        return out[::-1]


class Repertoire:
    """A decision tree for one side, built from a PGN file."""

    def __init__(self, path: Path):
        with open(path, encoding="utf-8") as f:
            game = chess.pgn.read_game(f)
        h = game.headers
        self.id = path.stem
        self.path = path
        self.mtime = path.stat().st_mtime
        self.title = h.get("Event", self.id)
        self.color = "b" if h.get("Color", "White").lower().startswith("b") else "w"
        self.description = h.get("Description", "")
        self.nodes: list[Node] = []
        self.root = self._add(None, game, game.board())
        # positions reached by several move orders: leaves point to the branch that continues
        cont = {}
        for n in self.nodes:
            if n.children:
                cont.setdefault(n.fenkey, n)
        for n in self.nodes:
            if not n.children and cont.get(n.fenkey) not in (None, n):
                n.transpose = cont[n.fenkey]

    def _add(self, parent, gnode, board):
        san = uci = None
        ours = False
        if gnode.move is not None:
            san, uci = board.san(gnode.move), gnode.move.uci()
            ours = self.our_turn(board)
            board.push(gnode.move)
        n = Node(len(self.nodes), parent, san, uci, board.fen(), openings.fenkey(board), ours,
                 comment=(gnode.comment or "").strip(), nag="".join(NAG_SYM.get(x, "") for x in sorted(gnode.nags))[:2])
        self.nodes.append(n)
        for i, v in enumerate(gnode.variations):
            c = self._add(n, v, board)
            c.alt = c.ours and i > 0
            n.children.append(c)
        if gnode.move is not None:
            board.pop()
        return n

    def our_turn(self, board_or_node) -> bool:
        turn = board_or_node.turn if isinstance(board_or_node, chess.Board) else board_or_node.fen.split()[1] == "w"
        return turn == (self.color == "w")

    def cards(self) -> set:
        """Positions where the user has to find the repertoire move (spaced-repetition cards)."""
        return {n.fenkey for n in self.nodes if self.our_turn(n) and n.next}

    def lines(self, start: Node | None = None) -> list:
        """Every root-to-leaf path through `start` along the main repertoire moves, following transpositions
        (lists of nodes, root excluded)."""
        start = start or self.root
        prefix = start.path
        out = []

        def walk(n, path, seen):
            nxt = [c for c in n.next if c.id not in seen and not c.alt]
            if not nxt or len(out) > 2000:
                out.append(path)
                return
            for c in nxt:
                walk(c, path + [c], seen | {c.id})
        walk(start, prefix, frozenset(n.id for n in prefix))
        return out


# ------------------------------------------------------------------ loading (reloaded when a PGN changes)
_cache: dict = {}
_cache_lock = threading.Lock()


def all_reps() -> list:
    with _cache_lock:
        paths = sorted(REP_DIR.glob("*.pgn")) if REP_DIR.exists() else []
        for p in paths:
            r = _cache.get(p.stem)
            if r is None or r.mtime != p.stat().st_mtime:
                try:
                    _cache[p.stem] = Repertoire(p)
                except Exception as e:  # noqa: BLE001  (broken PGN: skip it rather than break the page)
                    print(f"repertoire {p.name}: {e}")
        for k in set(_cache) - {p.stem for p in paths}:
            del _cache[k]
        order = {"london": 0, "caro-kann": 1, "slav": 2}
        return sorted(_cache.values(), key=lambda r: (order.get(r.id, 9), r.title))


def get(rid: str) -> Repertoire | None:
    return next((r for r in all_reps() if r.id == rid), None)


# ------------------------------------------------------------------ spaced repetition
def progress(rid: str) -> dict:
    return {r["fenkey"]: r for r in db.q("SELECT * FROM rep_progress WHERE rep_id=?", (rid,))}


def card_stats(rep: Repertoire, prog: dict | None = None) -> dict:
    prog = progress(rep.id) if prog is None else prog
    now = time.time()
    cards = rep.cards()
    seen = [prog[k] for k in cards if k in prog]
    return {"cards": len(cards), "new": len(cards) - len(seen),
            "due": sum(1 for p in seen if p["due_at"] <= now),
            "learned": sum(1 for p in seen if p["interval_days"] >= LEARNED_DAYS)}


def review(rid: str, fenkey: str, correct: bool) -> dict:
    p = db.q1("SELECT * FROM rep_progress WHERE rep_id=? AND fenkey=?", (rid, fenkey)) or \
        {"reps": 0, "interval_days": 0, "ease": 2.3, "lapses": 0}
    s = training.srs_next(p, correct)
    db.run("""INSERT OR REPLACE INTO rep_progress(rep_id, fenkey, due_at, interval_days, ease, reps, lapses, last_ts)
              VALUES(?,?,?,?,?,?,?,?)""",
           (rid, fenkey, s["due_at"], s["interval_days"], s["ease"], s["reps"], s["lapses"], int(time.time())))
    return {"next_due_days": round(s["interval_days"], 1)}


def pick_line(rep: Repertoire, mode: str = "due", start_id: int | None = None) -> dict | None:
    """Choose a line to drill: favour lines holding due cards (mode due), unseen cards (new), or anything (all)."""
    start = rep.nodes[start_id] if start_id is not None and 0 <= start_id < len(rep.nodes) else rep.root
    prog = progress(rep.id)
    now = time.time()
    scored = []
    for path in rep.lines(start):
        prev, due, new, weak = rep.root, 0, 0, 0
        for n in path:
            if n.ours:
                p = prog.get(prev.fenkey)
                if p is None:
                    new += 1
                else:
                    due += p["due_at"] <= now
                    weak += p["lapses"]
            prev = n
        scored.append((path, due, new, weak))
    used = mode
    pool = []
    for m in ([mode] if mode == "all" else [mode, "new" if mode == "due" else "due", "all"]):
        if m == "due":
            pool = [(p, 3 * d + w) for p, d, n, w in scored if d]
        elif m == "new":
            pool = [(p, n) for p, d, n, w in scored if n]
        else:
            pool = [(p, 1 + 3 * d + n + w) for p, d, n, w in scored]
        if pool:
            used = m
            break
    if not pool:
        return None
    path = random.choices([p for p, _ in pool], weights=[w for _, w in pool])[0]
    auto_until = len(start.path)
    steps, prev = [], rep.root
    for i, n in enumerate(path):
        steps.append({"id": n.id, "uci": n.uci, "san": n.san, "ours": n.ours, "auto": i < auto_until,
                      "card": prev.fenkey if n.ours else None,
                      "accept": [c.uci for c in prev.next if c.ours] if n.ours else None})
        prev = n
    return {"mode": used, "steps": steps, "leaf": path[-1].id if path else rep.root.id}


# ------------------------------------------------------------------ the user's own games
def games_report(rep: Repertoire) -> dict:
    """Walk every game played with the repertoire colour along the tree: how far it followed the preparation,
    where the user deviated, and which opponent moves are not covered yet."""
    games = db.q("""SELECT id, played_at, white, black, user_result, time_class FROM games
                    WHERE user_color=? ORDER BY played_at DESC""", (rep.color,))
    out = {"games": 0, "complete": 0, "avg_depth": None, "deviations": [], "holes": [], "pos": {}}
    if not games:
        return out
    ids = [g["id"] for g in games]
    moves = defaultdict(list)
    for m in db.q(f"SELECT game_id, ply, san, uci, loss FROM moves WHERE game_id IN ({','.join('?' * len(ids))}) AND ply<=60 "
                  "ORDER BY game_id, ply", ids):
        moves[m["game_id"]].append(m)
    pos = defaultdict(lambda: {"n": 0, "w": 0, "d": 0, "l": 0, "moves": Counter()})
    holes = {}
    depths = []
    for g in games:
        node, depth, exit_move, complete = rep.root, 0, None, False
        visited = []     # (position node, move played there)
        for m in moves[g["id"]]:
            nxt = node.next
            if not nxt:
                complete = True
                break
            visited.append((node, m["san"]))
            hit = next((c for c in nxt if c.uci == m["uci"]), None)
            if hit is None or hit.alt:
                exit_move = m
                break
            node, depth = hit, depth + 1
        if not depth:
            continue   # first move not covered (e.g. 1.d4 for the Caro-Kann): not a game of this opening
        res = g["user_result"]
        out["games"] += 1
        out["complete"] += complete
        depths.append(depth)
        for n, san in visited:
            p = pos[n.id]
            p["n"] += 1
            p["moves"][san] += 1
            if res in ("win", "draw", "loss"):
                p[res[0]] += 1
        if exit_move is None:
            continue
        nxt = node.next
        if rep.our_turn(node):
            exp = next((c for c in nxt if c.ours), nxt[0])
            out["deviations"].append({
                "game_id": g["id"], "ply": exit_move["ply"], "played_at": g["played_at"],
                "opponent": g["black"] if rep.color == "w" else g["white"], "result": res, "tc": g["time_class"],
                "played": exit_move["san"], "expected": exp.san, "node": node.id,
                "alt": any(c.alt and c.uci == exit_move["uci"] for c in nxt), "loss": exit_move["loss"]})
        else:
            h = holes.setdefault((node.id, exit_move["uci"]), {"node": node.id, "san": exit_move["san"],
                                                               "uci": exit_move["uci"], "n": 0,
                                                               "game_id": g["id"], "ply": exit_move["ply"]})
            h["n"] += 1
    out["avg_depth"] = round(sum(depths) / len(depths) / 2, 1) if depths else None
    out["deviations"] = out["deviations"][:60]
    out["holes"] = sorted(holes.values(), key=lambda h: -h["n"])[:40]
    out["pos"] = {k: {**v, "moves": dict(v["moves"].most_common(8))} for k, v in pos.items() if v["n"]}
    return out


# ------------------------------------------------------------------ Stockfish annotations
EVAL_STATE = {"running": False, "done": 0, "total": 0}
_eval_lock = threading.Lock()


def cached_evals(fenkeys) -> dict:
    keys = list(set(fenkeys))
    out = {}
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        for r in db.q(f"SELECT fenkey, depth, lines FROM evals WHERE fenkey IN ({','.join('?' * len(chunk))})", chunk):
            if r["depth"] >= EVAL_DEPTH:
                out[r["fenkey"]] = json.loads(r["lines"])[0]
    return out


def ensure_evals():
    """Evaluate (once, in the background) every repertoire position missing from the eval cache."""
    with _eval_lock:
        if EVAL_STATE["running"]:
            return
        todo = {}
        for rep in all_reps():
            for n in rep.nodes:
                todo.setdefault(n.fenkey, n.fen)
        missing = [fen for k, fen in todo.items() if k not in cached_evals(todo)]
        if not missing:
            return
        EVAL_STATE.update(running=True, done=0, total=len(missing))

    def job():
        try:
            def prog(i, n):
                EVAL_STATE["done"] = i
            training.util_engine().lines_many([chess.Board(f) for f in missing], EVAL_DEPTH, 1, prog)
        except Exception as e:  # noqa: BLE001
            print(f"repertoire evals: {e}")
        finally:
            EVAL_STATE["running"] = False
    threading.Thread(target=job, daemon=True).start()


def _quality(loss: float) -> str:
    return "??" if loss >= 25 else "?" if loss >= 12 else "?!" if loss >= 6 else ""


# ------------------------------------------------------------------ API payloads
def summary(rep: Repertoire, report: dict | None = None) -> dict:
    report = report or games_report(rep)
    return {"id": rep.id, "title": rep.title, "color": rep.color, "description": rep.description,
            "positions": len(rep.nodes), **card_stats(rep),
            "games": report["games"], "deviations": len(report["deviations"]), "holes": len(report["holes"])}


def detail(rep: Repertoire) -> dict:
    ensure_evals()
    report = games_report(rep)
    evs = cached_evals(n.fenkey for n in rep.nodes)
    book = openings.load()
    nodes = []
    for n in rep.nodes:
        ev = evs.get(n.fenkey)
        best_san = loss = None
        if ev and ev["pv"]:
            try:
                b = chess.Board(n.fen)
                best_san = b.san(chess.Move.from_uci(ev["pv"][0]))
            except ValueError:
                pass
        pev = evs.get(n.parent.fenkey) if n.parent else None
        if ev and pev:
            sign = 1 if n.parent.fen.split()[1] == "w" else -1
            loss = round(max(0.0, winprob(sign * pev["cp"]) - winprob(sign * ev["cp"])), 1)
        hit = book.get(n.fenkey)
        nodes.append({
            "id": n.id, "p": n.parent.id if n.parent else None, "san": n.san, "uci": n.uci, "ours": n.ours, "alt": n.alt,
            "fen": n.fen, "fk": n.fenkey, "c": n.comment, "ch": [c.id for c in n.children],
            "tr": n.transpose.id if n.transpose else None,
            "nag": n.nag or (_quality(loss) if loss is not None and not n.ours else ""),
            "loss": loss, "cp": ev["cp"] if ev else None, "mate": ev["mate"] if ev else None, "best": best_san,
            "eco": hit[0] if hit else None, "opening": hit[1] if hit else None,
        })
    prog = progress(rep.id)
    return {**summary(rep, report), "nodes": nodes, "report": report, "evals": dict(EVAL_STATE),
            "progress": {k: {"due_at": v["due_at"], "reps": v["reps"], "lapses": v["lapses"], "interval_days": v["interval_days"]}
                         for k, v in prog.items()}}
