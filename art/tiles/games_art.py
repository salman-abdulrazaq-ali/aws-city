"""
The mini-games' stage props (src/game/scenes/games/): side-view pieces in the team pack's style (a 1 px navy outline,
flat shades lit from the upper left), drawn at 1x; each game draws them at its whole-number play scale. Every sprite is
game:<game>:<prop>, with <game> the scene's id. Colours are the ones the scenes use: Security Keep red (Shield Wall,
Permission Gate, Red Team Range), Network Junction violet (Queue Juggler), the desk's info blue (a flood), amber and
green (a missed and a hit file), the flashcards' paper (the notice board, so its text keeps its contrast).

  shield    wall-top (32x14), wall (32x16, a course of masonry that stacks upward), gate (32x56: an arch with the
            portcullis half up), flood0..2 (40x28: a swarm of packets, three jitter frames on one canvas)
  redteam   lane1..5 (36x48: a lane's booth with its number), scanner (36x70: the agent's scanning console)
  queue     belt (32x24, tiles sideways: the belt's edge, a violet rail, rollers), bench (64x28: the worker's bench),
            dlq (40x56: the dead-letter bin with its plate), tray (32x16, tiles sideways: the queue's roller rack)
  iamgate   post (8x40), arm (160x8: the striped boom, its pivot hub at the left end), board (48x48 9-slice: the
            notice board's frame round a sheet of paper), booth (36x60: the guard's booth)
  edge      counter (48x48 9-slice: the post-office counter round the cache cubbies), phone (8x12: a viewer's phone),
            file-miss and file-hit (8x8: an envelope, amber for a trip to the origin, green for a hit)

Anchors: the middle of the foot for things that stand; the pivot for the boom's arm; the top-left corner for the pieces
that tile or stretch (wall, belt, tray, the 9-slices: drawn edge to edge so the atlas never trims them). Deterministic:
no randomness but the seeded jitter. Called from generate_tiles.main as games_art.build(add).
"""
import math

from PIL import Image, ImageDraw

from generate_tiles import A, CLEAR, CON_D, CON_L, CON_M, GLASS, NAVY, NAVY_D, OUTLINE, WHITE, WOOD, WOOD_D, outline, seeded, shade

SEC = (221, 52, 76)          # Security Keep (AWS security category colour)
NET = (140, 79, 255)         # Network Junction (AWS networking category colour)
INFO = (143, 184, 232)       # the desk's info blue (src/game/theme.ts CSS.info)
INFO_HI = (214, 228, 245)    # infoInk
AMBER = (240, 166, 58)       # the desk's accent
GREEN = (93, 179, 158)       # the desk's good
PAPER = (217, 207, 186)      # the flashcards' paper (CSS.paper): the board's text is drawn for it
INK = (27, 18, 0)            # paperInk
RUBBER = (44, 49, 56)        # graphite belt
SCREEN = (12, 30, 26)

# Pixel glyphs: 3x5 digits for the lanes, 4x5 letters for the bin's plate.
DIGITS = {
    "1": [".X.", "XX.", ".X.", ".X.", "XXX"],
    "2": ["XX.", "..X", ".X.", "X..", "XXX"],
    "3": ["XX.", "..X", ".X.", "..X", "XX."],
    "4": ["X.X", "X.X", "XXX", "..X", "..X"],
    "5": ["XXX", "X..", "XX.", "..X", "XX."],
}
LETTERS = {
    "D": ["XXX.", "X..X", "X..X", "X..X", "XXX."],
    "L": ["X...", "X...", "X...", "X...", "XXXX"],
    "Q": [".XX.", "X..X", "X..X", "X.XX", ".XXX"],
}


# ── helpers ───────────────────────────────────────────────────────────────────

def flat(w, h):
    img = Image.new("RGBA", (w, h), CLEAR)
    return img, ImageDraw.Draw(img)


def R(d, x0, y0, x1, y1, col, a=255):
    """A filled rectangle, corners inclusive."""
    if x1 >= x0 and y1 >= y0:
        d.rectangle((x0, y0, x1, y1), fill=A(col, a))


def P(d, x, y, col, a=255):
    d.point([(x, y)], fill=A(col, a))


def glyph(d, g, x, y, col, s=1):
    for r, row in enumerate(g):
        for k, ch in enumerate(row):
            if ch == "X":
                R(d, x + k * s, y + r * s, x + k * s + s - 1, y + r * s + s - 1, col)


def bevel(d, x0, y0, x1, y1, col, hi=1.18, lo=0.74):
    """A lit block: a light top row and left column, a dark bottom row and right column."""
    R(d, x0, y0, x1, y1, col)
    R(d, x0, y0, x1, y0, shade(col, hi))
    R(d, x0, y0, x0, y1, shade(col, hi * 0.96))
    R(d, x0, y1, x1, y1, shade(col, lo))
    R(d, x1, y0 + 1, x1, y1, shade(col, lo * 1.06))


def bricks(d, x0, x1, y0, y1, col, course=8, brick=10):
    """Masonry from y0 to y1 between x0 and x1: courses `course` px tall, each brick lit at its top and left."""
    mortar = shade(col, 0.55)
    R(d, x0, y0, x1, y1, col)
    for k, top in enumerate(range(y0, y1 + 1, course)):
        bot = min(y1, top + course - 1)  # the mortar row
        off = (brick // 2) * (k % 2)
        for x in range(x0 - brick + off, x1 + 1, brick):
            a, b = max(x0, x + 1), min(x1, x + brick - 1)
            if a > b:
                continue
            R(d, a, top, b, top, shade(col, 1.18))
            R(d, a, top + 1, a, bot - 2, shade(col, 1.08))
            R(d, a, bot - 1, b, bot - 1, shade(col, 0.84))
            if x >= x0:
                R(d, x, top, x, bot, mortar)
        R(d, x0, bot, x1, bot, mortar)


def nine(w, h, ring):
    """A 9-slice frame: `ring(d, side)` gives each ring's colour by its depth from the edge (0 = outside) and side."""
    img, d = flat(w, h)
    for y in range(h):
        for x in range(w):
            sides = {"top": y, "left": x, "bottom": h - 1 - y, "right": w - 1 - x}
            side = min(sides, key=lambda s: (sides[s], ("top", "left", "bottom", "right").index(s)))
            P(d, x, y, ring(sides[side], side))
    return img, d


# ── Shield Wall ───────────────────────────────────────────────────────────────

def shield_wall_top():
    """The battlements: three merlons over a coping band. No outline at the bottom: a wall course goes under it."""
    img, d = flat(32, 14)
    for x0, x1 in ((1, 8), (12, 19), (23, 30)):
        bevel(d, x0, 1, x1, 7, SEC, lo=0.82)
        R(d, x0, 1, x1, 1, shade(CON_L, 1.0))
    R(d, 1, 8, 30, 13, CON_M)
    R(d, 1, 8, 30, 8, CON_L)
    R(d, 1, 8, 1, 13, CON_L)
    R(d, 30, 9, 30, 13, CON_D)
    R(d, 1, 12, 30, 13, shade(CON_M, 0.8))
    return outline(img)


def shield_wall():
    """One stretch of the wall: two courses of security-red masonry, edged left and right."""
    img, d = flat(32, 16)
    bricks(d, 1, 30, 0, 15, SEC)
    R(d, 1, 0, 1, 15, shade(SEC, 1.12))
    R(d, 30, 0, 30, 15, shade(SEC, 0.72))
    R(d, 0, 0, 0, 15, OUTLINE)
    R(d, 31, 0, 31, 15, OUTLINE)
    return img


def shield_gate():
    """The wall's foot: a stone string course, masonry, and an arched gateway with the portcullis half up."""
    img, d = flat(32, 56)
    R(d, 1, 0, 30, 2, CON_M)
    R(d, 1, 0, 30, 0, CON_L)
    R(d, 1, 2, 30, 2, CON_D)
    bricks(d, 1, 30, 3, 50, SEC)
    R(d, 1, 3, 1, 50, shade(SEC, 1.12))
    R(d, 30, 3, 30, 50, shade(SEC, 0.72))
    # the plinth
    bevel(d, 1, 51, 30, 54, CON_D, hi=1.25, lo=0.7)
    # the arch: a stone ring round a dark way in (14 wide)
    cx, top, r = 15.5, 27, 8
    for y in range(top - r - 2, 55):
        for x in range(6, 26):
            dx, dy = x - cx, max(0, top - y)
            ring = math.hypot(dx, dy)
            inside = abs(dx) <= r - 2 and (y >= top or ring <= r - 2)
            stone = abs(dx) <= r and (y >= top or ring <= r)
            if inside:
                P(d, x, y, NAVY_D)
            elif stone and y <= 50:
                P(d, x, y, CON_M if dx <= 0 else CON_D)
    R(d, 15, top - r, 16, top - r + 1, CON_L)  # keystone
    # the portcullis: steel bars down to its teeth, half way down the opening
    bars = range(10, 22, 3)
    for x in bars:
        R(d, x, top - r + 2, x, 38, CON_M)
        P(d, x, 39, CON_L)
    for y in (24, 31):
        R(d, 10, y, 21, y, CON_D)
    for x in bars:
        P(d, x, 24, CON_L)
        P(d, x, 31, CON_L)
    # the way in: a lit floor
    R(d, 9, 52, 22, 54, shade(NAVY, 1.1))
    return outline(img)


def shield_flood(frame):
    """A flood: a haze and a swarm of packets in the desk's info blue, streaking left. Frames jitter each packet a pixel."""
    w, h = 40, 28
    haze, hd = flat(w, h)
    hd.ellipse((1, 3, 38, 26), fill=A(INFO, 64))
    hd.ellipse((6, 7, 33, 22), fill=A(INFO, 40))
    dots, d = flat(w, h)
    spots = [(8, 14), (14, 7), (17, 17), (23, 10), (26, 19), (31, 13), (11, 21), (20, 3)]
    r = seeded(f"game:shield:flood{frame}")
    for i, (x, y) in enumerate(spots):
        x += r(3) - 1 if frame else 0
        y += r(3) - 1 if frame else 0
        for k in range(2 + i % 3):  # the streak behind it (the swarm moves left)
            P(hd, x + 5 + k, y + 2, INFO, 150 - 40 * k)
        R(d, x, y, x + 3, y + 3, INFO)
        R(d, x, y, x + 2, y, INFO_HI)
        P(d, x, y + 1, INFO_HI)
        R(d, x + 1, y + 3, x + 3, y + 3, shade(INFO, 0.7))
        P(d, x + 3, y + 2, shade(INFO, 0.7))
    haze.alpha_composite(outline(dots))
    return haze


# ── Red Team Range ────────────────────────────────────────────────────────────

def redteam_lane(n):
    """A lane's booth: a red header with the lane's number on a white plate, two posts, a dark bay and a counter."""
    img, d = flat(36, 48)
    # the bay between the posts
    R(d, 4, 15, 31, 46, NAVY_D)
    for y in range(18, 34, 5):  # the back wall's slats
        R(d, 4, y, 31, y, shade(NAVY_D, 1.35))
    # posts
    for x0 in (1, 32):
        bevel(d, x0, 14, x0 + 2, 46, CON_M, hi=1.2, lo=0.7)
    # header board, the plate and the number
    bevel(d, 1, 1, 34, 15, SEC)
    R(d, 1, 13, 34, 15, shade(SEC, 0.7))
    bevel(d, 12, 2, 23, 14, WHITE, hi=1.0, lo=0.82)
    glyph(d, DIGITS[str(n)], 15, 3, INK, s=2)
    # the counter across the bay's foot, with a red stripe
    bevel(d, 1, 36, 34, 46, CON_D, hi=1.25, lo=0.72)
    R(d, 2, 40, 33, 41, SEC)
    return outline(img)


def redteam_scanner():
    """The Security Agent's console: a screen with a radar sweep and two blips, status lights, a keyboard ledge."""
    img, d = flat(36, 70)
    bevel(d, 4, 28, 31, 64, NAVY, hi=1.3, lo=0.7)
    for y in range(46, 62, 4):  # vents
        R(d, 8, y, 27, y, NAVY_D)
    # the head with its screen
    bevel(d, 1, 1, 34, 29, CON_D, hi=1.3, lo=0.7)
    R(d, 4, 4, 31, 25, SCREEN)
    cx, cy = 17, 24
    for rr in (5, 9, 13):
        d.arc((cx - rr, cy - rr, cx + rr, cy + rr), 180, 360, fill=A(shade(GREEN, 0.55)))
    R(d, 4, 24, 31, 24, shade(GREEN, 0.55))
    d.line([(cx, cy), (cx + 12, cy - 15)], fill=A(GREEN))
    d.line([(cx + 1, cy), (cx + 13, cy - 14)], fill=A(shade(GREEN, 0.7)))
    R(d, 9, 13, 10, 14, SEC)        # a flaw
    R(d, 24, 17, 25, 18, GREEN)     # a fine request
    R(d, 4, 4, 31, 4, shade(SCREEN, 1.8))
    # status lights and the keyboard ledge
    for i, col in enumerate((GREEN, AMBER, SEC)):
        R(d, 9 + i * 7, 32, 11 + i * 7, 33, col)
    bevel(d, 1, 37, 34, 41, CON_M, hi=1.25, lo=0.72)
    for x in range(4, 32, 3):
        P(d, x, 39, CON_D)
    # the plinth
    bevel(d, 2, 64, 33, 68, CON_D, hi=1.2, lo=0.7)
    return outline(img)


# ── Queue Juggler ─────────────────────────────────────────────────────────────

def queue_belt():
    """The conveyor's near side: the belt's edge, a violet rail, rollers in their housing, legs. Tiles sideways."""
    img, d = flat(32, 24)
    R(d, 0, 0, 31, 3, RUBBER)
    R(d, 0, 0, 31, 0, shade(RUBBER, 1.35))
    for x in (0, 8, 16, 24):
        R(d, x, 1, x, 3, shade(RUBBER, 0.7))
    R(d, 0, 4, 31, 4, OUTLINE)
    R(d, 0, 5, 31, 5, shade(NET, 1.3))
    R(d, 0, 6, 31, 6, NET)
    R(d, 0, 7, 31, 7, shade(NET, 0.7))
    R(d, 0, 8, 31, 8, OUTLINE)
    R(d, 0, 9, 31, 17, NAVY_D)
    for cx in (8, 24):
        d.ellipse((cx - 4, 9, cx + 3, 16), fill=A(CON_M))
        d.ellipse((cx - 4, 9, cx + 3, 16), outline=A(OUTLINE))
        R(d, cx - 2, 11, cx - 1, 11, CON_L)
        P(d, cx - 1, 12, NAVY)
    R(d, 0, 18, 31, 18, OUTLINE)
    for x0 in (2, 18):  # legs
        R(d, x0, 19, x0 + 3, 23, OUTLINE)
        R(d, x0 + 1, 19, x0 + 2, 22, CON_M)
        R(d, x0 + 1, 19, x0 + 1, 22, CON_L)
    return img


def queue_bench():
    """The worker's bench: a wooden top, a drawer, a low shelf with an amber toolbox."""
    img, d = flat(64, 28)
    for x0 in (4, 55):  # legs
        bevel(d, x0, 9, x0 + 3, 26, WOOD_D, hi=1.2, lo=0.75)
    bevel(d, 5, 20, 58, 22, WOOD_D, hi=1.2, lo=0.75)  # the shelf
    bevel(d, 38, 14, 51, 19, AMBER, hi=1.2, lo=0.72)  # the toolbox on it
    R(d, 42, 12, 47, 12, CON_D)
    R(d, 42, 13, 42, 13, CON_D)
    R(d, 47, 13, 47, 13, CON_D)
    R(d, 39, 16, 50, 16, shade(AMBER, 0.72))
    bevel(d, 3, 6, 60, 10, WOOD_D, hi=1.15, lo=0.72)  # the apron
    bevel(d, 24, 7, 39, 9, shade(WOOD_D, 0.88), hi=1.1, lo=0.8)
    R(d, 31, 8, 32, 8, CON_L)
    bevel(d, 1, 1, 62, 5, WOOD, hi=1.2, lo=0.72)  # the top
    for x in (14, 33, 50):
        P(d, x, 3, shade(WOOD, 0.85))
    return outline(img)


def queue_dlq():
    """The dead-letter bin: a red lid with a letter slot, a graphite body with a DLQ plate and a hazard band, wheels."""
    img, d = flat(40, 56)
    bevel(d, 3, 10, 36, 48, NAVY, hi=1.3, lo=0.72)
    for x in range(9, 34, 6):  # ribs
        R(d, x, 12, x, 46, shade(NAVY, 0.82))
    bevel(d, 1, 2, 38, 9, SEC, lo=0.7)
    R(d, 8, 5, 31, 6, NAVY_D)  # the slot letters drop through
    R(d, 8, 4, 31, 4, shade(SEC, 0.7))
    # the plate
    bevel(d, 5, 16, 34, 31, WHITE, hi=1.0, lo=0.8)
    x = 7
    for ch in "DLQ":
        glyph(d, LETTERS[ch], x, 19, INK, s=2)
        x += 9
    # the hazard band: diagonal amber and dark stripes
    for y in range(37, 41):
        for x in range(4, 36):
            P(d, x, y, AMBER if ((x + y) // 3) % 2 else NAVY_D)
    # wheels
    for cx in (10, 29):
        d.ellipse((cx - 4, 47, cx + 4, 54), fill=A(NAVY_D))
        R(d, cx - 1, 50, cx, 51, CON_M)
    return outline(img)


def queue_tray():
    """The queue's rack: a steel shelf the parcels stand on, a row of rollers, a violet rail, legs. Tiles sideways."""
    img, d = flat(32, 16)
    R(d, 0, 0, 31, 0, OUTLINE)
    R(d, 0, 1, 31, 1, CON_L)
    R(d, 0, 2, 31, 2, CON_M)
    R(d, 0, 3, 31, 3, OUTLINE)
    R(d, 0, 4, 31, 8, NAVY_D)
    for cx in (4, 12, 20, 28):
        d.ellipse((cx - 2, 4, cx + 2, 8), fill=A(CON_M))
        P(d, cx - 1, 5, CON_L)
    R(d, 0, 9, 31, 9, OUTLINE)
    R(d, 0, 10, 31, 10, shade(NET, 1.25))
    R(d, 0, 11, 31, 11, shade(NET, 0.8))
    R(d, 0, 12, 31, 12, OUTLINE)
    for x0 in (3, 19):
        R(d, x0, 13, x0 + 3, 15, OUTLINE)
        R(d, x0 + 1, 13, x0 + 2, 14, CON_M)
    return img


# ── Permission Gate ───────────────────────────────────────────────────────────

def iam_post():
    """A boom post: graphite steel with two red bands, a light cap with an amber lamp, a base plate."""
    img, d = flat(8, 40)
    bevel(d, 1, 3, 6, 38, CON_M, hi=1.25, lo=0.7)
    for y in (9, 17):
        bevel(d, 1, y, 6, y + 3, SEC, hi=1.15, lo=0.75)
    bevel(d, 1, 1, 6, 4, CON_L, hi=1.1, lo=0.8)
    R(d, 3, 1, 4, 1, AMBER)
    bevel(d, 1, 35, 6, 38, CON_D, hi=1.2, lo=0.7)
    return outline(img)


def iam_arm():
    """The boom: red and white stripes, a pivot hub at the left end (the anchor), an amber reflector at the tip."""
    img, d = flat(160, 8)
    for x in range(4, 158):
        col = SEC if ((x - 8) // 12) % 2 == 0 else WHITE
        R(d, x, 2, x, 5, col)
        P(d, x, 2, shade(col, 1.15) if col == SEC else WHITE)
        P(d, x, 5, shade(col, 0.72))
    R(d, 153, 3, 156, 4, AMBER)
    d.ellipse((1, 1, 6, 6), fill=A(CON_M))
    P(d, 2, 2, CON_L)
    R(d, 3, 3, 4, 4, NAVY_D)
    return outline(img)


def iam_board():
    """The notice board's frame, a 9-slice (10 px each side): wood round flat paper, a red pin in each corner."""
    def ring(depth, side):
        lit = side in ("top", "left")
        if depth == 0:
            return OUTLINE
        if depth == 1:
            return WOOD if lit else WOOD_D
        if depth in (2, 3):
            return WOOD_D if lit else shade(WOOD_D, 0.8)
        if depth == 4:
            return shade(WOOD_D, 0.72)
        if depth == 5:
            return OUTLINE
        return PAPER
    img, d = nine(48, 48, ring)
    for x, y in ((7, 7), (38, 7), (7, 38), (38, 38)):
        R(d, x, y, x + 2, y + 2, SEC)
        P(d, x, y, shade(SEC, 1.35))
        P(d, x + 2, y + 2, shade(SEC, 0.6))
    return img


def iam_booth():
    """The guard's booth in security red: a flat roof with an amber lamp, a wide window with a ledge, a panelled base."""
    img, d = flat(36, 60)
    bevel(d, 3, 8, 32, 57, SEC, lo=0.72)
    # the window and its ledge
    bevel(d, 6, 13, 29, 32, NAVY_D, hi=1.4, lo=0.9)
    R(d, 8, 15, 27, 30, GLASS)
    R(d, 8, 23, 27, 30, shade(GLASS, 0.82))
    d.line([(10, 21), (15, 16)], fill=A(WHITE))
    d.line([(12, 22), (17, 17)], fill=A(shade(GLASS, 1.12)))
    bevel(d, 4, 33, 31, 35, CON_L, hi=1.05, lo=0.78)
    # the panel and the base
    bevel(d, 7, 39, 28, 52, shade(SEC, 0.86), hi=1.15, lo=0.8)
    R(d, 17, 40, 18, 51, shade(SEC, 0.7))
    bevel(d, 2, 54, 33, 58, CON_D, hi=1.2, lo=0.7)
    # the roof and its lamp
    bevel(d, 1, 4, 34, 8, CON_D, hi=1.3, lo=0.68)
    R(d, 15, 1, 20, 3, AMBER)
    R(d, 16, 1, 17, 1, shade(AMBER, 1.3))
    return outline(img)


# ── Edge Cache ────────────────────────────────────────────────────────────────

def edge_counter():
    """The post-office counter, a 9-slice (top 8, sides 5, bottom 7): a wooden lip, posts and a plinth round dark cubbies."""
    w, h = 48, 48
    img, d = flat(w, h)
    R(d, 0, 0, w - 1, h - 1, shade(NAVY_D, 0.8))
    # the cubbies' back: a faint shelf line under the lip
    R(d, 5, 8, w - 6, 8, shade(NAVY_D, 1.3))
    # posts
    for x0, lit in ((0, True), (w - 5, False)):
        R(d, x0, 0, x0 + 4, h - 1, OUTLINE)
        R(d, x0 + 1, 1, x0 + 3, h - 2, WOOD_D if lit else shade(WOOD_D, 0.82))
        R(d, x0 + 1, 1, x0 + 1, h - 2, WOOD if lit else WOOD_D)
    # the lip
    R(d, 0, 0, w - 1, 7, OUTLINE)
    R(d, 1, 1, w - 2, 1, shade(WOOD, 1.18))
    R(d, 1, 2, w - 2, 5, WOOD)
    R(d, 1, 6, w - 2, 6, WOOD_D)
    # the plinth
    R(d, 0, h - 7, w - 1, h - 1, OUTLINE)
    R(d, 1, h - 6, w - 2, h - 4, WOOD_D)
    R(d, 1, h - 6, w - 2, h - 6, WOOD)
    R(d, 1, h - 3, w - 2, h - 2, shade(WOOD_D, 0.7))
    return img


def edge_phone():
    img, d = flat(8, 12)
    R(d, 1, 1, 6, 10, NAVY_D)
    R(d, 2, 2, 5, 8, GLASS)
    P(d, 2, 2, WHITE)
    R(d, 4, 6, 5, 8, shade(GLASS, 0.8))
    R(d, 3, 9, 4, 9, CON_M)
    return outline(img)


def edge_file(col):
    """An envelope with its flap's V, outlined."""
    img, d = flat(8, 8)
    R(d, 1, 1, 6, 6, col)
    R(d, 1, 1, 6, 1, shade(col, 1.25))
    for k in range(3):
        P(d, 1 + k, 2 + k, shade(col, 0.66))
        P(d, 6 - k, 2 + k, shade(col, 0.66))
    R(d, 1, 6, 6, 6, shade(col, 0.78))
    return outline(img)


def build(add):
    foot = lambda img: (img.width // 2, img.height)  # noqa: E731 - the middle of its foot
    corner = (0, 0)
    add("game:shield:wall-top", shield_wall_top(), corner)
    add("game:shield:wall", shield_wall(), corner)
    add("game:shield:gate", shield_gate(), (16, 56))
    for f in range(3):
        add(f"game:shield:flood{f}", shield_flood(f), (20, 28))
    for n in range(1, 6):
        img = redteam_lane(n)
        add(f"game:redteam:lane{n}", img, foot(img))
    img = redteam_scanner()
    add("game:redteam:scanner", img, foot(img))
    add("game:queue:belt", queue_belt(), corner)
    img = queue_bench()
    add("game:queue:bench", img, foot(img))
    img = queue_dlq()
    add("game:queue:dlq", img, foot(img))
    add("game:queue:tray", queue_tray(), corner)
    img = iam_post()
    add("game:iamgate:post", img, foot(img))
    add("game:iamgate:arm", iam_arm(), (4, 4))
    add("game:iamgate:board", iam_board(), corner)
    img = iam_booth()
    add("game:iamgate:booth", img, foot(img))
    add("game:edge:counter", edge_counter(), corner)
    img = edge_phone()
    add("game:edge:phone", img, (4, 6))
    add("game:edge:file-miss", edge_file(AMBER), (4, 4))
    add("game:edge:file-hit", edge_file(GREEN), (4, 4))


def preview(sprites, path, scale=4):
    """Every game:* sprite on the desk's graphite, scaled up (.cache/art/games-preview.png)."""
    names = sorted(n for n in sprites if n.startswith("game:"))
    pics = [sprites[n][0] for n in names]
    w = sum(p.width for p in pics) + 6 * (len(pics) + 1)
    h = max(p.height for p in pics) + 12
    sheet = Image.new("RGBA", (w, h), (21, 23, 27, 255))
    x = 6
    for p in pics:
        sheet.alpha_composite(p, (x, h - 6 - p.height))
        x += p.width + 6
    sheet.resize((w * scale, h * scale), Image.NEAREST).save(path)
