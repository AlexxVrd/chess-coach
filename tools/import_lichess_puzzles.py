"""Import a filtered subset of the lichess puzzle database (CC0) into data/lichess_puzzles.db.

usage: python -I tools/import_lichess_puzzles.py data/downloads/lichess_puzzles/lichess_db_puzzle.csv.zst data/lichess_puzzles.db
Standard library only (+ the `zstd` binary). The CSV is treated as untrusted data: it is only parsed, never executed.
"""
import csv
import os
import sqlite3
import subprocess
import sys

MIN_RATING, MAX_RATING = 900, 2500
MIN_POPULARITY, MIN_PLAYS, MAX_RD = 95, 1000, 85


def main(src, dst):
    if os.path.exists(dst):
        os.remove(dst)
    db = sqlite3.connect(dst)
    db.executescript("""
      CREATE TABLE puzzles (id TEXT PRIMARY KEY, fen TEXT, moves TEXT, rating INTEGER, popularity INTEGER, plays INTEGER,
                            themes TEXT, opening TEXT);
      CREATE TABLE puzzle_theme (theme TEXT, rating INTEGER, id TEXT);
    """)
    proc = subprocess.Popen(["zstd", "-dc", src], stdout=subprocess.PIPE, text=True, encoding="utf-8")
    rd = csv.DictReader(proc.stdout)
    batch, tbatch, n, seen = [], [], 0, 0
    for r in rd:
        seen += 1
        try:
            rating, pop, plays, dev = int(r["Rating"]), int(r["Popularity"]), int(r["NbPlays"]), int(r["RatingDeviation"])
        except (ValueError, KeyError):
            continue
        if not (MIN_RATING <= rating <= MAX_RATING) or pop < MIN_POPULARITY or plays < MIN_PLAYS or dev > MAX_RD:
            continue
        moves = r["Moves"].split()
        if len(moves) < 2 or len(moves) > 12:
            continue
        themes = r["Themes"].split()
        batch.append((r["PuzzleId"], r["FEN"], r["Moves"], rating, pop, plays, r["Themes"], r.get("OpeningTags", "")))
        tbatch.extend((t, rating, r["PuzzleId"]) for t in themes)
        n += 1
        if len(batch) >= 20000:
            db.executemany("INSERT OR IGNORE INTO puzzles VALUES(?,?,?,?,?,?,?,?)", batch)
            db.executemany("INSERT INTO puzzle_theme VALUES(?,?,?)", tbatch)
            batch, tbatch = [], []
    db.executemany("INSERT OR IGNORE INTO puzzles VALUES(?,?,?,?,?,?,?,?)", batch)
    db.executemany("INSERT INTO puzzle_theme VALUES(?,?,?)", tbatch)
    db.executescript("CREATE INDEX idx_p_rating ON puzzles(rating); CREATE INDEX idx_t ON puzzle_theme(theme, rating);")
    db.commit()
    db.execute("VACUUM")
    print(f"scanned {seen}, kept {n}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
