"""Authoring source for the opening repertoires: one full line per string, comments in {} after a move.

Main repertoire move first; extra moves of ours at the same position (listed later) become "accepted
alternatives" (they must stay leaves). Rebuild the PGNs with: .venv/bin/python tools/build_repertoires.py --write
"""

LONDON = dict(
    id="london", title="Système de Londres", color="w",
    description="Un seul schéma contre presque tout : d4, Bf4, e3, Nf3, c3, Nbd2, Bd3, h3, O-O. Peu de théorie, des structures solides, et des idées qui reviennent toujours.",
    lines=[
        # ---- 1...d5 2.Bf4 Nf6 3.e3 e6
        "d4{Le coup de base : on prend le centre et on libère le fou c1.} d5 Bf4{Le fou sort AVANT e3 pour ne pas être enfermé derrière ses pions : c'est toute l'idée du Londres.} Nf6 e3{Ouvre la diagonale du fou f1 et soutient d4.} e6 Nf3 c5 c3{Le triangle c3-d4-e3 : ton centre est imprenable.} Nc6 Nbd2{Le cavalier va en d2 (pas en c3, où il gênerait le pion c3) et soutiendra la poussée e4.} Bd6 Bg3{On garde le fou : si ...Bxg3, hxg3 ouvre la colonne h à ta tour.} O-O Bd3{Plan : O-O puis Ne5 + f4 (attaque à l'aile roi), ou Qe2 + e4 (ouverture du centre).}",
        "d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Qb6{L'attaque sur b2 est LA réaction typique contre le Londres.} Qb3{On défend b2 en proposant l'échange : après ...Qxb3 axb3, ta tour a1 devient active sur la colonne a.} c4 Qc2{Le blocage ...c4 ferme l'aile dame : ton plan devient e4 pour ouvrir le centre.}",
        "d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Qb6{Même idée, avant ...Nc6.} Qb3{Même réponse : on couvre b2 et on propose l'échange.}",
        "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6{Les Noirs proposent l'échange des fous.} Bg3{On recule en g3 : si ...Bxg3, hxg3 et la colonne h est à toi.} O-O Bd3 c5 c3 Nc6 Nbd2",
        "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6 Bg3 Bxg3 hxg3{On reprend vers le centre : la tour h1 travaille déjà sur la colonne h semi-ouverte.} c5 c3 Nc6 Nbd2",
        "d4 d5 Bf4 Nf6 e3 e6 Nf3 Be7 Bd3{Développement naturel : le fou vise h7.} c5 c3 Nc6 Nbd2 O-O O-O{Même plan qu'ailleurs : Ne5, f4 ou e4 selon la position.}",
        # ---- 3...c5
        "d4 d5 Bf4 Nf6 e3 c5 c3{Comme toujours : le triangle c3-d4-e3.} Nc6 Nd2{Ici Nd2 d'abord : si ...Qb6, Qb3 sans laisser b2.} e6 Ngf3 Bd6 Bg3 O-O Bd3",
        "d4 d5 Bf4 Nf6 e3 c5 c3 Qb6 Qb3{On couvre b2 et on propose l'échange des dames.}",
        "d4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 Qb6 Qb3",
        "d4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 Bf5{Le fou f5 a quitté c8 : b7 n'est plus défendu.} Qb3{On attaque b7 tout de suite.}",
        # ---- 3...Bf5
        "d4 d5 Bf4 Nf6 e3 Bf5{Les Noirs copient ton fou.} c4{Quand le fou noir sort en f5, b7 est sans défense : c4 puis Qb3 l'exploite.} e6 Nc3 c6 Qb3{On attaque b7.} Qb6 c5{On chasse la dame noire avec gain de temps.} Qxb3 axb3{La colonne a s'ouvre pour ta tour.}",
        # ---- 3...g6
        "d4 d5 Bf4 Nf6 e3 g6{Les Noirs fianchettent : le fou g7 visera d4 et b2.} Nf3 Bg7 Be2{Simple et solide.} O-O O-O c5 c3",
        # ---- 3...c6
        "d4 d5 Bf4 Nf6 e3 c6 Nf3 Bf5 Bd3{On échange le meilleur fou des Noirs.} Bxd3 Qxd3 e6 Nbd2",
        "d4 d5 Bf4 Nf6 e3 c6 Nf3 Bg4 Nbd2{Soutient e4 et le cavalier f3.} e6 c3 Bd6 h3{On pose la question au fou g4 avant de décider quoi faire de Bf4.}",
        # ---- 2...c5
        "d4 d5 Bf4 c5 e3 Nc6 c3 Nf6 Nd2",
        "d4 d5 Bf4 c5 e3 Qb6 Nc3{Le pion b2 est empoisonné : si ...Qxb2 ?, Nxd5 ! et les Noirs s'effondrent.} Qxb2? Nxd5{Menace Nc7+ (fourchette roi-tour) et Rb1 qui chasse la dame : les Blancs gagnent.}",
        "d4 d5 Bf4 c5 e3 cxd4 exd4{On reprend avec le pion e : structure solide et colonne e semi-ouverte.} Nc6 c3",
        # ---- 2...Bf5 / 2...e6 / 2...c6
        "d4 d5 Bf4 Bf5 e3 Nf6 c4",
        "d4 d5 Bf4 Bf5 e3 e6 c4{Même idée : c4 puis Qb3 contre b7.}",
        "d4 d5 Bf4 e6 e3 Nf6 Nf3",
        "d4 d5 Bf4 e6 e3 c5 c3 Nc6 Nd2 Nf6 Ngf3",
        "d4 d5 Bf4 c6 e3 Nf6 Nf3",
        "d4 d5 Bf4 c6 e3 Bf5 Bd3",
        # ---- 1...Nf6
        "d4 Nf6 Bf4 d5 e3",
        "d4 Nf6 Bf4 g6 e3 Bg7 Nf3 O-O Be2 d6 h3{Une case de retraite en h2 pour le fou contre ...Nh5 ou ...e5.} c5 c3",
        "d4 Nf6 Bf4 g6 e3 Bg7 Nf3 d6 Be2 O-O h3",
        "d4 Nf6 Bf4 g6 e3 Bg7 Nf3 c5 c3{Le triangle tient d4.}",
        "d4 Nf6 Bf4 e6 e3 c5 c3 d5 Nd2 Nc6 Ngf3",
        "d4 Nf6 Bf4 e6 e3 d5 Nf3",
        "d4 Nf6 Bf4 e6 e3 b6 Nf3 Bb7 h3{Une case de retraite pour le fou f4.}",
        "d4 Nf6 Bf4 c5 e3 Nc6 d5{Le cavalier n'a pas encore de pion d5 devant lui : on le chasse et on gagne de l'espace avec tempo.} Nb8 Nc3{Puis e4 : un centre énorme.}",
        "d4 Nf6 Bf4 c5 e3 Nc6 d5 Na5 a3{Menace b4 : le cavalier a5 n'a plus de case.}",
        "d4 Nf6 Bf4 c5 e3 Nc6 d5 e5 Bg3",
        "d4 Nf6 Bf4 c5 e3 Qb6 Nc3",
        "d4 Nf6 Bf4 c5 e3 cxd4 exd4 d5 c3",
        "d4 Nf6 Bf4 d6 e3 g6 Nf3 Bg7",
        # ---- other first moves
        "d4 e6 Bf4 d5 e3 Nf6 Nf3",
        "d4 e6 Bf4 c5 e3",
        "d4 e5{Le gambit Englund : dangereux si on ne connaît pas le piège.} dxe5{On prend le pion.} Nc6 Nf3{On défend e5.} Qe7 Bf4{On défend encore e5. ATTENTION au piège : après ...Qb4+ Bd2 Qxb2, ne joue SURTOUT PAS Bc3 ?? à cause de ...Bb4 ! et ...Qc1#.} Qb4+ Bd2 Qxb2 Nc3{Le bon coup : on développe, la dame noire est en danger et Rb1 va suivre.}",
        "d4 e5 dxe5 d6{Les Noirs veulent rendre le pion contre du développement.} Nf3{Pas besoin de prendre : on garde e5 et on développe.} dxe5 Qxd8+ Kxd8 Nxe5{Un pion de plus, et le roi noir a perdu le roque.}",
        "d4 e5 dxe5 f6{Le gambit Soller.} e4{Inutile de prendre : on garde e5 et on construit un centre énorme. Le pion f6 a affaibli la diagonale e8-h5.} fxe5? Qh5+{Le coup qui punit ...f6 : après ...g6, Qxe5+ fourchette le roi et la tour h8.}",
        "d4 e5 dxe5 f6 e4 Nc6 Nf3",
        "d4 g6 Bf4{Contre ...g6, e4 (centre complet) est aussi très bon ; on reste dans le Londres pour garder tes plans habituels.} Bg7 e3 d6 Nf3 Nf6 Be2",
        "d4 g6 Bf4 Bg7 e3 c5 c3 Qb6 Qb3",
        "d4 f5{La Hollandaise.} Bf4 Nf6 e3 e6 Nf3 Be7 h3 O-O Bd3",
        "d4 d6 Bf4 Nf6 e3 g6 Nf3 Bg7",
        "d4 d6 Bf4 g6 Nf3 Bg7 e3 Nf6",
        "d4 c5{La Benoni : on prend de l'espace avec d5.} d5 e5 e4 d6 Nc3",
        "d4 c5 d5 Nf6 Nc3 d6 e4",
        "d4 c5 d5 e6 e4",
        "d4 Nc6 d5{On chasse le cavalier : gain de temps et d'espace.} Ne5 e4",
        "d4 Nc6 d5 Nb8 e4",
        "d4 c6 Bf4 d5 e3",
        # ---- holes found in the user's games
        "d4 d5 Bf4 Nc6{Le coup le plus fréquent de tes adversaires ici.} e3 Bf5 c4{Toujours la même idée contre ...Bf5 : c4 puis Qb3 contre b7.}",
        "d4 d5 Bf4 Nc6 e3 Bg4?{Erreur fréquente : le fou n'est pas défendu.} Qxg4{Après e3, la case e2 est vide : ta dame prend le fou g4. Une pièce de plus !}",
        "d4 d5 Bf4 Nc6 e3 Nf6 Nf3",
        "d4 d5 Bf4 Nc6 e3 e6 c4",
        "d4 Nf6 Bf4 Nc6 e3 d5 Nf3",
        "d4 d5 Bf4 e5?!{Un gambit douteux.} dxe5{On prend : les Noirs n'ont pas assez de compensation.}",
        "d4 d5 Bf4 g6 e3",
        "d4 e5 dxe5 Bc5?!{Les Noirs visent f2.} Nf3{Développe, défend h4 et garde le pion e5.}",
        # ---- accepted alternatives (your habits that are just as good)
        "d4 d5 Bf4 Nf6 Nf3{Aussi bon que e3 (c'est même le choix de Stockfish) : on retombe sur les mêmes plans.}",
        "d4 d5 Bf4 e6 Nf3{Aussi jouable que e3 : mêmes plans.}",
        "d4 d5 Bf4 Bf5 Nf3{Jouable, mais e3 + c4 met plus de pression sur b7.}",
        "d4 g6 e4{Très bon aussi (meilleur selon Stockfish), mais on sort du Londres.}",
        "d4 d6 e4{Très bon aussi : on entre dans la Pirc avec un centre complet.}",
        "d4 e6 e4{Très bon aussi : on entre dans la Française.}",
        "d4 c6 e4{Très bon aussi : on entre dans une Caro-Kann côté blanc.}",
        "d4 Nc6 e4{Bon aussi : centre complet.}",
    ],
)

CARO = dict(
    id="caro-kann", title="Caro-Kann (contre 1.e4)", color="b",
    description="1.e4 c6 puis ...d5 : on conteste le centre, on sort le fou c8 avant ...e6, et on vise des structures saines. Les finales sont souvent bonnes pour toi.",
    lines=[
        # ---- Advance 3.e5
        "e4 c6{La Caro-Kann : on prépare ...d5 sans enfermer le fou c8 (contrairement à la Française).} d4 d5{On conteste le centre tout de suite.} e5{La variante d'avance.} Bf5{Le fou sort AVANT ...e6 : c'est tout l'intérêt de la Caro-Kann.} Nf3 e6 Be2 c5{La rupture typique : on attaque la base de la chaîne de pions (d4).} O-O Nc6 c3 cxd4 cxd4 Nge7",
        "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 cxd4 Nxd4 Ne7",
        "e4 c6 d4 d5 e5 Bf5 Bd3 Bxd3{On échange : ce fou blanc était le meilleur défenseur des cases blanches.} Qxd3 e6 Nf3 c5{La rupture ...c5 tout de suite : on attaque d4 avant que les Blancs ne le consolident.}",
        "e4 c6 d4 d5 e5 Bf5 Nc3 e6 g4{Attaque agressive contre le fou.} Bg6 Nge2 c5{Toujours la même rupture contre d4.}",
        "e4 c6 d4 d5 e5 Bf5 h4{Les Blancs menacent h5 pour piéger/chasser le fou.} h5{On bloque le pion h : le fou garde la case g6 au besoin.}",
        "e4 c6 d4 d5 e5 Bf5 c3 e6",
        "e4 c6 d4 d5 e5 Bf5 Be3 e6",
        # ---- Exchange 3.exd5
        "e4 c6 d4 d5 exd5 cxd5{On reprend avec le pion c : structure symétrique, colonne c semi-ouverte pour toi.} Bd3{La variante d'échange.} Nc6{Pression sur d4.} c3 Nf6 Bf4 Bg4{Le fou sort avant ...e6, comme toujours.} Qb3 Qd7{On défend b7 calmement.} Nd2 e6 Ngf3 Bd6",
        "e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Nf3 Bg4 O-O e6",
        "e4 c6 d4 d5 exd5 cxd5 c4{L'attaque Panov : les Blancs acceptent un pion isolé en d4.} Nf6 Nc3 e6 Nf3 Be7 cxd5 Nxd5 Bd3 Nc6 O-O O-O{Bloque le pion isolé (case d5) et échange les pièces : les finales seront pour toi.}",
        "e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Be7 Bd3 dxc4 Bxc4 O-O",
        "e4 c6 d4 d5 exd5 cxd5 Nf3 Nf6 Bd3 Nc6 c3 Bg4",
        # ---- Classical 3.Nc3 / 3.Nd2
        "e4 c6 d4 d5 Nc3 dxe4{On prend : le cavalier blanc reprend en e4.} Nxe4 Bf5{Le fou sort en attaquant le cavalier.} Ng3 Bg6 h4 h6{On prépare une case de retraite (h7) pour le fou contre h5.} Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6{Structure idéale : plan ...Ngf6, ...Be7 ou ...Qc7, puis ...c5.}",
        "e4 c6 d4 d5 Nd2 dxe4 Nxe4",
        "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 Nf3 Nd7 h4 h6 h5 Bh7 Bd3 Bxd3 Qxd3 e6",
        "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 Bc4 e6 N1e2 Nf6",
        "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Nc5 b6 Nb3 e6",
        "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Bd3? Qxd4{Le pion d4 n'était plus défendu : on le prend.}",
        # ---- other 3rd moves
        "e4 c6 d4 d5 f3{La Fantaisie : les Blancs soutiennent e4 avec un pion.} e6{Solide : on prépare ...c5 ou ...Bb4.} Nc3 Bb4",
        "e4 c6 d4 d5 Nf3 dxe4 Ng5 Bf5",
        # ---- 2.Nf3
        "e4 c6 Nf3 d5 Nc3{Les Deux Cavaliers.} Bg4{On cloue le cavalier f3.} h3 Bxf3{On donne la paire de fous mais on garde une structure saine et on gagne du temps.} Qxf3 e6 d3 Nf6",
        "e4 c6 Nf3 d5 Nc3 Bg4 h3 Bxf3 Qxf3 e6 d4 dxe4 Nxe4 Qxd4",
        "e4 c6 Nf3 d5 Nc3 Bg4 Be2 e6 d4 Nf6",
        "e4 c6 Nf3 d5 e5 Bf5 d4 e6 Be2",
        "e4 c6 Nf3 d5 e5 Bf5 Be2 e6",
        "e4 c6 Nf3 d5 exd5 cxd5 d4 Nf6 Bd3 Nc6 c3 Bg4",
        "e4 c6 Nf3 d5 exd5 cxd5 Bb5+ Nc6",
        "e4 c6 Nf3 d5 d3 dxe4 dxe4 Qxd1+ Kxd1{Les Blancs ont perdu le droit de roquer.}",
        "e4 c6 Nf3 d5 d4",
        # ---- 2.Nc3 and others
        "e4 c6 Nc3 d5 Nf3",
        "e4 c6 Nc3 d5 d4",
        "e4 c6 Nc3 d5 Qf3 dxe4 Nxe4 Nd7",
        "e4 c6 Nc3 d5 exd5 cxd5 d4 Nf6",
        "e4 c6 Bc4 d5 exd5 cxd5 Bb5+ Bd7 Bxd7+ Qxd7",
        "e4 c6 Bc4 d5 Bb3 dxe4 Qh5 e6",
        "e4 c6 c4 d5 exd5 cxd5 cxd5 Nf6",
        "e4 c6 c4 d5 cxd5 cxd5 exd5 Nf6",
        "e4 c6 d3 d5 Nd2 e5 Ngf3 Bd6",
        "e4 c6 Qf3?!{La dame sort trop tôt.} d5 exd5 cxd5",
        "e4 c6 f4 d5 e5 Bf5 Nf3 e6",
        # ---- holes found in the user's games
        "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng5{Le cavalier vise f7 et e6.} e6{Solide : on ferme la diagonale et f7 est couvert.}",
        "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Qf3?!{La dame sort trop tôt.} e6",
        "e4 c6 Bc4 d5 exd5 cxd5 Bb3 Nf6",
        "e4 c6 d4 d5 exd5 cxd5 Nc3",
        "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Bd3 Bxd3 Qxd3",
        "e4 c6 d4 d5 e5 Bf5 Nf3 e6 h3 c5",
        "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Nbd2 c5",
        "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Nc3 Nd7",
        "e4 c6 d4 d5 e5 Bf5 c4 e6",
        "e4 c6 d4 d5 e5 Bf5 f4 e6",
        "e4 c6 Nc3 d5 e5?!{Les Blancs avancent trop tôt.} d4{Le cavalier c3 doit bouger : tu gagnes de l'espace avec tempo.} Nce2 c5",
        "e4 c6 d4 d5 c4?!{Le pion e4 n'est plus défendu.} dxe4{On prend !}",
        # ---- accepted alternatives (your habits that are just as good)
        "e4 c6 Nf3 d5 exd5 cxd5 d4 Bf5{Aussi bon : ton coup habituel.}",
        "e4 c6 Nc3 d5 exd5 cxd5 d4 Bf5{Aussi bon : ton coup habituel.}",
        "e4 c6 Bc4 d5 exd5 cxd5 Bb5+ Nc6{Aussi bon.}",
    ],
)

SLAV = dict(
    id="slav", title="Slave (contre 1.d4)", color="b",
    description="1.d4 d5 puis ...c6 : la même structure que ta Caro-Kann. On soutient d5 avec le pion c, on sort le fou c8, et on répond au Londres avec ...c5.",
    lines=[
        # ---- 2.c4 c6 3.Nf3 Nf6 4.Nc3
        "d4 d5{On occupe le centre comme les Blancs.} c4{Le gambit Dame.} c6{La Slave : on soutient d5 avec le pion c, comme dans la Caro-Kann, et le fou c8 reste libre.} Nf3 Nf6 Nc3 dxc4{On prend le pion c4 : les Blancs vont devoir perdre du temps pour le récupérer.} a4{Empêche ...b5 qui garderait le pion.} Bf5{Le fou sort, comme d'habitude.} e3 e6 Bxc4 Bb4{Clouage sur le cavalier c3 : on contrôle e4.} O-O O-O",
        "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 e3 b5{Ici on peut garder le pion.} a4 b4 Na2 e6",
        # ---- 4.e3
        "d4 d5 c4 c6 Nf3 Nf6 e3 Bf5{Le fou sort AVANT ...e6.} Nc3 e6 Nh4{Les Blancs veulent la paire de fous.} Bg6 Nxg6 hxg6{Colonne h semi-ouverte pour ta tour : pas de souci.}",
        "d4 d5 c4 c6 Nf3 Nf6 e3 Bf5 Nc3 e6 Bd3 Bxd3 Qxd3 Nbd7",
        "d4 d5 c4 c6 Nf3 Nf6 e3 Bf5 Qb3 Qb6",
        "d4 d5 c4 c6 Nf3 Nf6 Qc2 dxc4 Qxc4 Bf5",
        "d4 d5 c4 c6 Nf3 Nf6 cxd5 cxd5 Nc3 Nc6 Bf4 Bf5 e3 e6",
        # ---- Exchange
        "d4 d5 c4 c6 cxd5 cxd5{Slave d'échange : structure symétrique, très solide.} Nc3 Nf6 Bf4 Nc6 e3 Bf5 Nf3 e6 Qb3 Bb4",
        "d4 d5 c4 c6 cxd5 cxd5 Nf3 Nf6 Nc3 Nc6",
        "d4 d5 c4 c6 cxd5 cxd5 Bf4 Nc6 e3 Nf6 Nc3 Bf5",
        # ---- 3.Nc3
        "d4 d5 c4 c6 Nc3 Nf6{Surtout pas ...Bf5 ? ici : Qb3 ! attaque b7 et d5, et les Blancs gagnent du matériel.} Nf3",
        "d4 d5 c4 c6 Nc3 Nf6 e3 e6{Après Nc3 + e3, ...Bf5 ? est une erreur : cxd5 cxd5 Qb3 ! attaque b7 et le fou ne peut plus revenir défendre. Donc ...e6 : la Semi-Slave.} Nf3 Nbd7 Bd3 dxc4 Bxc4 b5 Bd3 Bb7",
        "d4 d5 c4 c6 Nc3 Nf6 cxd5 cxd5",
        "d4 d5 c4 c6 Nc3 Nf6 Bg5 dxc4",
        "d4 d5 c4 c6 e3 Nf6 Nc3",
        "d4 d5 c4 c6 e3 Nf6 Nf3",
        # ---- London against you
        "d4 d5 Bf4{Le Londres contre toi.} Nf6 e3 c5{On frappe le centre tout de suite : la réponse la plus active au Londres.} c3 Nc6 Nd2 e6 Ngf3 Bd6 Bg3 O-O Bd3 Qe7{Prépare ...e5 : la rupture centrale libère tes pièces.}",
        "d4 d5 Bf4 Nf6 e3 c5 Nf3 Nc6 c3 e6 Nbd2 Bd6 Bg3 O-O Bd3 Qe7",
        "d4 d5 Bf4 Nf6 e3 c5 Nc3 cxd4 exd4 a6",
        "d4 d5 Bf4 Nf6 e3 c5 dxc5 e6",
        "d4 d5 Bf4 Nf6 Nf3 c5 e3 Nc6 c3",
        "d4 d5 Bf4 Nf6 Nc3 e6",
        # ---- 2.Nf3 / 2.e3
        "d4 d5 Nf3 Nf6 c4 c6",
        "d4 d5 Nf3 Nf6 Bf4 c5 e3 Nc6 c3",
        "d4 d5 Nf3 Nf6 e3 Bf5{Contre le Colle (e3 + Bd3), on sort le fou avant.} Bd3 e6",
        "d4 d5 Nf3 Nf6 e3 Bf5 c4 c6",
        "d4 d5 Nf3 Nf6 g3 c6 Bg2 Bf5",
        "d4 d5 Nf3 Nf6 Bg5 e6",
        "d4 d5 e3 Nf6 Nf3",
        "d4 d5 e3 Nf6 Bd3 c5 c3 Nc6 f4 Bg4",
        "d4 d5 e3 Nf6 c4 c6",
        # ---- 2.Nc3 / gambits / others
        "d4 d5 Nc3 Nf6 Bg5{La Veresov.} Bf5",
        "d4 d5 Nc3 Nf6 Bf4 e6",
        "d4 d5 Nc3 Nf6 e4",
        "d4 d5 e4?!{Le gambit Blackmar-Diemer.} dxe4{On accepte.} Nc3 Nf6 f3 exf3 Nxf3 g6{Fianchetto : ton roi sera à l'abri et le fou g7 frappera d4. Tu gardes ton pion de plus.}",
        "d4 d5 e4 dxe4 f3 e5{La contre-attaque Lemberger : on rend le pion pour échanger les dames.} dxe5 Qxd1+ Kxd1 Nc6",
        "d4 d5 Bg5 h6 Bh4 c6",
        "d4 d5 g3 Nf6 Bg2 c6",
        # ---- holes found in the user's games
        "d4 d5 c3 Nf6",
        # ---- accepted alternatives (your habits that are just as good)
        "d4 d5 e3 Bf5{Ton coup habituel : jouable, mais attention à c4 puis Qb3 contre b7.}",
        "d4 d5 Bf4 Bf5{Ton coup habituel : jouable (le miroir), mais c4 puis Qb3 contre b7 est gênant.}",
        "d4 d5 Nf3 Bf5{Ton coup habituel : jouable, mais attention à c4 puis Qb3 contre b7.}",
    ],
)

REPS = [LONDON, CARO, SLAV]
