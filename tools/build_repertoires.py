"""Build the repertoire PGNs (data/repertoires/*.pgn) from tools/repertoire_lines.py.

Checks that every move is legal and that a position reached by two move orders gets the same answer,
then (with --engine) asks Stockfish to flag our moves that lose more than --thresh centipawns.

usage (from the project folder):
    .venv/bin/python tools/build_repertoires.py                 # check only
    .venv/bin/python tools/build_repertoires.py --engine 20     # + Stockfish check (a few minutes)
    .venv/bin/python tools/build_repertoires.py --write         # write data/repertoires/*.pgn
"""
import argparse
import importlib.util
import re
import sys
from collections import defaultdict
from pathlib import Path

import chess
import chess.pgn

HERE = Path(__file__).parent
TOK = re.compile(r"\{([^}]*)\}|([^\s{]+)")
NAGS = {"!!": 3, "!": 1, "!?": 5, "?!": 6, "?": 2, "??": 4}


def load_lines():
    spec = importlib.util.spec_from_file_location("lines", HERE / "repertoire_lines.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m.REPS


def build(rep):
    game = chess.pgn.Game()
    game.headers.clear()
    game.headers["Event"] = rep["title"]
    game.headers["Site"] = "Chess Coach"
    game.headers["Result"] = "*"
    game.headers["Color"] = "White" if rep["color"] == "w" else "Black"
    game.headers["Description"] = rep["description"]
    errors = []
    for li, line in enumerate(rep["lines"]):
        node, board = game, chess.Board()
        for com, tok in TOK.findall(line):
            if com:
                c = com.strip()
                if node.comment and node.comment != c:
                    errors.append(f"line {li}: conflicting comment at {node.san() if node.parent else 'root'}")
                node.comment = c
                continue
            m = re.match(r"^(.*?)([!?]{1,2})?$", tok)
            san, nag = m.group(1), m.group(2)
            try:
                move = board.parse_san(san)
            except ValueError as e:
                errors.append(f"line {li}: illegal {tok} in {board.fen()}: {e}")
                break
            child = node.variation(move) if node.has_variation(move) else node.add_variation(move)
            if nag:
                child.nags.add(NAGS[nag])
            board.push(move)
            node = child
    return game, errors


def check(rep, game):
    ours = chess.WHITE if rep["color"] == "w" else chess.BLACK
    warn = []
    by_key = defaultdict(set)
    count = {"positions": 0, "ours": 0, "leaves": 0}
    stack = [game]
    while stack:
        n = stack.pop()
        b = n.board()
        count["positions"] += 1
        if not n.variations:
            count["leaves"] += 1
        if b.turn == ours and n.variations:
            count["ours"] += 1
            # extra own moves are "accepted alternatives": they must stay leaves (the main move carries the plan)
            for alt in n.variations[1:]:
                if alt.variations:
                    warn.append(f"alternative {alt.san()} has a continuation at {b.epd()}")
            by_key[b.epd(en_passant='legal')].add(n.variations[0].move.uci())
        stack.extend(n.variations)
    for k, v in by_key.items():
        if len(v) > 1:
            warn.append(f"inconsistent transposition {k}: {v}")
    return count, warn


def engine_check(rep, game, depth):
    import chess.engine
    from concurrent.futures import ThreadPoolExecutor
    ours = chess.WHITE if rep["color"] == "w" else chess.BLACK
    jobs = []
    stack = [game]
    seen = set()
    while stack:
        n = stack.pop()
        stack.extend(n.variations)
        b = n.board()
        if b.turn != ours or not n.variations:
            continue
        k = b.epd()
        if k in seen:
            continue
        seen.add(k)
        jobs.append((n, b))
    import queue
    pool = queue.Queue()
    engines = []
    for _ in range(8):
        e = chess.engine.SimpleEngine.popen_uci("stockfish")
        e.configure({"Threads": 1, "Hash": 64})
        engines.append(e)
        pool.put(e)
    sign = 1 if ours == chess.WHITE else -1

    def run(job):
        n, b = job
        e = pool.get()
        try:
            infos = e.analyse(b, chess.engine.Limit(depth=depth), multipv=3)
            mine = n.variations[0].move
            res = [(i["pv"][0], i["score"].white().score(mate_score=10000) * sign) for i in infos]
            mcp = next((cp for mv, cp in res if mv == mine), None)
            if mcp is None:
                b2 = b.copy(); b2.push(mine)
                i2 = e.analyse(b2, chess.engine.Limit(depth=depth))
                mcp = i2["score"].white().score(mate_score=10000) * sign
        finally:
            pool.put(e)
        best = res[0][1]
        path = " ".join(x.san() for x in [*reversed(list(_ancestors(n)))])
        return best - mcp, path, b.san(mine), [(b.san(mv), cp) for mv, cp in res], mcp
    with ThreadPoolExecutor(8) as ex:
        out = list(ex.map(run, jobs))
    for e in engines:
        e.quit()
    return out


def _ancestors(n):
    while n.parent is not None:
        yield n
        n = n.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", type=int, default=0)
    ap.add_argument("--only", default=None)
    ap.add_argument("--write", action="store_true", help="write the PGN files into data/repertoires")
    ap.add_argument("--out", default=None)
    ap.add_argument("--thresh", type=int, default=35)
    a = ap.parse_args()
    if a.write and not a.out:
        a.out = str(HERE.parent / "data" / "repertoires")
    for rep in load_lines():
        if a.only and rep["id"] != a.only:
            continue
        game, errors = build(rep)
        count, warn = check(rep, game)
        print(f"== {rep['id']}: {count}")
        for e in errors + warn:
            print("  !!", e)
        if a.engine:
            for loss, path, san, top, mcp in sorted(engine_check(rep, game, a.engine), key=lambda x: -x[0]):
                if loss >= a.thresh or mcp < -60:
                    print(f"  [{loss:4d}cp, ours {mcp:+5d}] {path}  -> {san}   top: {', '.join(f'{s} {c:+d}' for s, c in top)}")
        if a.out:
            Path(a.out).mkdir(parents=True, exist_ok=True)
            with open(Path(a.out) / f"{rep['id']}.pgn", "w", encoding="utf-8") as f:
                print(game.accept(chess.pgn.StringExporter(headers=True, variations=True, comments=True, columns=100)), file=f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
