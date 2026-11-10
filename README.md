# ♟ Chess Coach

Outil local d'analyse et d'entraînement pour progresser aux échecs (objectif 1300 → 1800-2000).
Tout tourne sur ton Mac : aucune donnée n'est envoyée ailleurs (hormis l'import depuis chess.com / lichess).

## Lancer

Double-clique sur `Lancer.command` (ou `./run.sh`) → ouvre http://127.0.0.1:8765

Premier lancement : **Paramètres** → pseudo chess.com → « Enregistrer et importer ».
L'analyse Stockfish démarre toute seule (les parties les plus récentes d'abord).

## Ce que fait l'outil

| Page | Fonction |
|---|---|
| **Tableau de bord** | Classement, précision, gaffes/partie, précision par phase, motifs d'erreurs, gestion du temps, conversion/résilience, et un **plan d'entraînement généré depuis tes parties** |
| **Parties** | Liste filtrable, import, file d'analyse, favoris |
| **Revue** | Échiquier + barre d'éval + graphe, classification des coups (brillant, très bon, meilleur, … gaffe), meilleur coup & ligne de réfutation, **« Réessayer ce coup »**, variantes libres avec moteur en direct, temps par coup, notes, bilan du coach |
| **Ouvertures** | Explorateur de TON répertoire (tes coups / réponses adverses, résultats, perte moyenne), bilan par ouverture, **fuites d'ouverture** |
| **Répertoire** | Arbres de décision **Londres** (blancs), **Caro-Kann** (contre 1.e4) et **Slave** (contre 1.d4) : pour chaque coup adverse, la réponse à jouer et pourquoi. Entraînement des lignes en répétition espacée, **tes écarts** dans tes vraies parties (avec leur coût) et les **trous** du répertoire (coups adverses rencontrés mais pas encore préparés) |
| **Entraînement** | **Tactiques classées** (612 000 puzzles lichess, classement tactique adaptatif, statistiques par schéma, révision des échecs) et **Mes erreurs** (puzzles tirés de tes parties, vérifiés par le moteur, à plusieurs coups, indices progressifs, répétition espacée) |
| **Finales** | 10 finales clés (mats de base, Lucena, Philidor, opposition…) à jouer contre Stockfish |
| **Analyse libre** | Échiquier libre + moteur multi-lignes, chargement FEN/PGN, **jouer contre Stockfish** à un Elo choisi |

Raccourcis (revue / analyse) : `←` `→` naviguer · `↑` `↓` début/fin · `F` retourner · (puzzles) `H` indice, `Entrée` suivant.

## Nouveautés v2

- **Analyse en deux passes** : balayage rapide de toutes les positions, puis revérification profonde (profondeur 24) des coups douteux, en comparant ton coup au meilleur coup **à profondeur égale**. Tablebases Syzygy 3-4-5 pièces (`data/syzygy`) pour des finales exactes. Réglable dans Paramètres → Qualité d'analyse. Les anciennes analyses sont mises à jour automatiquement (version 2).
- **Puzzles sans blocage** : retour du plateau automatique après une erreur, indices en 3 niveaux (thème → pièce → coup), solution rejouée sur l'échiquier, vérification instantanée.
- **Tactiques classées** : base lichess filtrée (`data/lichess_puzzles.db`, régénérable avec `tools/import_lichess_puzzles.py`).
- **Revue guidée** : parcours de tes grosses erreurs une par une (position avant le coup, indices, explication).
- **Séance du jour** + suivi de l'objectif (2000) sur le tableau de bord.

## Méthode conseillée (≈ 45 min/jour)

0. Ouvre le **Tableau de bord** : la « Séance du jour » te dit quoi faire (≈ 45 min).
1. 10-15 min : **Entraînement** — tactiques classées + tes erreurs.
2. 20 min : revue d'**une** partie récente (onglet Revue → moments clés → « Réessayer »).
3. 10 min : **Répertoire → S'entraîner** (positions à réviser), ou une finale.
4. Le dimanche : regarde le tableau de bord, suis le plan.

## Technique

- Backend : Python (FastAPI, python-chess), SQLite (`data/chesscoach.db`), Stockfish (Homebrew).
- Analyse : pool de moteurs Stockfish mono-thread en parallèle (≈ 3-5× plus rapide qu'un moteur multi-thread à profondeur fixe), cache des positions.
- Classification : seuils sur la perte de probabilité de gain (modèle lichess) ; précision pondérée par la volatilité.
- Ouvertures : table ECO de lichess (`data/*.tsv`).
- Répertoires : fichiers PGN avec variantes dans `data/repertoires/` (en-têtes `Color` et `Description`). Au tour du joueur, la 1re variante est le coup du répertoire, les suivantes des « variantes acceptées » ; au tour de l'adversaire, chaque variante est une réponse préparée. Les transpositions sont détectées toutes seules. On peut les modifier à la main, les importer d'une étude Lichess (export PGN), ou éditer `tools/repertoire_lines.py` puis lancer `.venv/bin/python tools/build_repertoires.py --engine 20 --write` (vérifie légalité, cohérence des transpositions et qualité des coups avec Stockfish).
- Sauvegarde : copie simplement `data/chesscoach.db`.

## Nouveautés v3
- **Sparring** (⚔️) : rejoue contre Stockfish (force réglable) une de tes erreurs, un avantage que tu n'as pas converti, une position de ton répertoire, ou une partie libre.
- **Calcul** (🧮) : puzzles longs (4+ coups à toi). Tu écris toute la ligne (notation française ou anglaise) ; mode aveugle optionnel.
- **Habitudes** (🧠) : gestion du temps (zeitnot, coups trop rapides), séries de défaites (« tilt »), fatigue par séance, heures de jeu — avec conseils personnalisés.
- Finales : 4 exercices de plus (pion seul, fou de mauvaise couleur, tour contre fou/cavalier).
- La séance du jour inclut Calcul et Sparring.
