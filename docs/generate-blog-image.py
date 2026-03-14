"""
Stochastic Cartography — Blog header image for "Stats without context are damned lies"

Subtle cricket reference: the topology of a match where context weights every delivery.
Contour-map aesthetic with accumulated marks representing ball-by-ball data,
density shifting where match pressure is highest.
"""

import math
import random
import os
from PIL import Image, ImageDraw, ImageFont

# Canvas
W, H = 2400, 1350  # 16:9 blog header
img = Image.new("RGB", (W, H), "#0a0e1a")
draw = ImageDraw.Draw(img)

# Palette — Stochastic Cartography
INDIGO = "#0a0e1a"
DEEP_BLUE = "#141b33"
SLATE = "#1e2844"
CHALK = "#e8e4dc"
CHALK_DIM = "#6b6860"
CHALK_FAINT = "#2a2f45"
AMBER = "#d4a54a"
AMBER_DIM = "#8a6d2e"
VERMILLION = "#c44b2f"
TEAL = "#2a7a6e"

random.seed(42)  # Reproducible

FONTS_DIR = os.path.expanduser(
    "~/Library/Application Support/Claude/local-agent-mode-sessions/"
    "skills-plugin/c3d0d341-d0da-4f76-9564-afc5856726b8/"
    "5530a323-0b80-4d40-b26b-9bc3cfc0e1f8/skills/canvas-design/canvas-fonts"
)

def load_font(name, size):
    try:
        return ImageFont.truetype(os.path.join(FONTS_DIR, name), size)
    except Exception:
        return ImageFont.load_default()

font_mono = load_font("DMMono-Regular.ttf", 14)
font_mono_sm = load_font("DMMono-Regular.ttf", 11)
font_label = load_font("InstrumentSans-Regular.ttf", 13)
font_title = load_font("Jura-Light.ttf", 18)
font_accent = load_font("Italiana-Regular.ttf", 42)


# === LAYER 1: Contour field — concentric arcs representing pressure zones ===

# Three focal points: batting crisis (left), bowling spell (center-right), match climax (right)
focal_points = [
    (480, 520, 38, CHALK_FAINT),    # batting entry difficulty zone
    (1500, 600, 30, CHALK_FAINT),   # bowling economy zone
    (1900, 400, 24, "#1a2240"),      # match outcome convergence
]

for fx, fy, num_rings, color in focal_points:
    for i in range(num_rings):
        r = 40 + i * 22
        # Slight wobble for organic feel
        points = []
        for angle in range(0, 360, 3):
            rad = math.radians(angle)
            wobble = random.gauss(0, 1.5)
            px = fx + (r + wobble) * math.cos(rad)
            py = fy + (r + wobble) * math.sin(rad)
            points.append((px, py))
        # Draw as thin line segments
        for j in range(len(points) - 1):
            # Fade opacity with distance from center
            alpha = max(0.15, 1.0 - i / num_rings)
            if alpha > 0.5:
                draw.line([points[j], points[j+1]], fill=color, width=1)
            elif alpha > 0.3:
                draw.line([points[j], points[j+1]], fill=CHALK_FAINT, width=1)


# === LAYER 2: Dot field — 120 overs x multiple deliveries, scattered as data marks ===
# Represents ball-by-ball data accumulation
# Denser in high-impact zones, sparser elsewhere

def impact_density(x, y):
    """Higher values = higher 'impact context' = denser marks"""
    d1 = math.sqrt((x - 480)**2 + (y - 520)**2)
    d2 = math.sqrt((x - 1500)**2 + (y - 600)**2)
    d3 = math.sqrt((x - 1900)**2 + (y - 400)**2)
    # Inverse distance weighting
    v = 200 / (d1 + 100) + 150 / (d2 + 100) + 250 / (d3 + 100)
    return v

for _ in range(8000):
    x = random.randint(80, W - 80)
    y = random.randint(80, H - 80)
    density = impact_density(x, y)

    if random.random() < density * 0.7:
        # High impact zone — amber/vermillion dots
        size = random.choice([1, 1, 1, 2, 2, 3])
        if density > 1.5:
            color = random.choice([AMBER, AMBER, AMBER, VERMILLION, CHALK])
        elif density > 0.8:
            color = random.choice([AMBER_DIM, AMBER_DIM, CHALK_DIM, TEAL])
        else:
            color = random.choice([CHALK_FAINT, CHALK_DIM, "#2a3555"])
        draw.ellipse([x-size, y-size, x+size, y+size], fill=color)

# Additional ambient scatter for the background field
for _ in range(2000):
    x = random.randint(80, W - 80)
    y = random.randint(80, H - 80)
    if random.random() < 0.35:
        draw.ellipse([x, y, x+1, y+1], fill=random.choice([CHALK_FAINT, "#1e2844"]))


# === LAYER 3: Horizontal scan lines — like a spectrograph reading ===

for y_line in range(120, H - 100, 45):
    # Each line represents an "over" — varying intensity
    x = 100
    while x < W - 100:
        segment_len = random.randint(3, 25)
        density = impact_density(x, y_line)
        if density > 0.7 and random.random() < 0.3:
            alpha_color = CHALK_FAINT if density < 1.0 else SLATE
            draw.line([(x, y_line), (x + segment_len, y_line)], fill=alpha_color, width=1)
        x += segment_len + random.randint(5, 30)


# === LAYER 4: Vertical tick marks — wicket events ===
# 10 vertical lines at specific x positions, representing wicket falls

wicket_positions = [320, 480, 610, 750, 920, 1180, 1420, 1580, 1750, 1900]
for wx in wicket_positions:
    # Short vertical tick
    tick_y = random.randint(200, H - 300)
    tick_h = random.randint(30, 90)
    draw.line([(wx, tick_y), (wx, tick_y + tick_h)], fill=VERMILLION, width=1)
    # Small circle at top
    draw.ellipse([wx-3, tick_y-3, wx+3, tick_y+3], outline=VERMILLION, width=1)


# === LAYER 5: Arc segments — partnership arcs connecting wicket events ===

for i in range(len(wicket_positions) - 1):
    x1 = wicket_positions[i]
    x2 = wicket_positions[i + 1]
    mid_x = (x1 + x2) / 2
    span = x2 - x1
    arc_h = span * 0.15

    if random.random() < 0.7:
        points = []
        for t in range(30):
            frac = t / 29
            px = x1 + frac * (x2 - x1)
            py = 750 - arc_h * math.sin(frac * math.pi)
            points.append((px, py))
        arc_color = AMBER_DIM if span < 300 else AMBER
        for j in range(len(points) - 1):
            draw.line([points[j], points[j+1]], fill=arc_color, width=1)
        # Partnership run label at arc apex
        if span > 150:
            mid_idx = len(points) // 2
            runs = random.choice([34, 52, 67, 78, 91, 112, 45, 28])
            draw.text((points[mid_idx][0] - 8, points[mid_idx][1] - 14),
                      str(runs), fill=CHALK_DIM, font=font_mono_sm)


# === LAYER 6: Reference grid — faint coordinate system ===

# Vertical gridlines with tiny labels
for gx in range(200, W - 100, 200):
    if random.random() < 0.4:
        draw.line([(gx, 60), (gx, H - 60)], fill="#161c30", width=1)
        # Tiny over number at top
        over_num = (gx - 200) // 200 + 1
        draw.text((gx + 4, 62), f"{over_num}", fill=CHALK_FAINT, font=font_mono_sm)

# Horizontal gridlines
for gy in range(150, H - 100, 150):
    if random.random() < 0.3:
        draw.line([(100, gy), (W - 100, gy)], fill="#161c30", width=1)


# === LAYER 7: Typography — clinical specimen labels ===

# Top-left: observation title
draw.text((100, 70), "STOCHASTIC CARTOGRAPHY", fill=CHALK_DIM, font=font_title)
draw.text((100, 95), "contextual impact topology  /  ball-by-ball accumulation", fill=CHALK_FAINT, font=font_mono_sm)

# Bottom-right: data source notation
draw.text((W - 380, H - 55), "10.9M deliveries  ·  cricsheet.org", fill=CHALK_FAINT, font=font_mono_sm)

# Axis-like labels along the bottom
labels = ["powerplay", "middle", "death", "settlement"]
positions = [250, 750, 1400, 1950]
for lbl, lx in zip(labels, positions):
    draw.text((lx, H - 80), lbl.upper(), fill=CHALK_DIM, font=font_label)
    # Small tick above
    draw.line([(lx, H - 90), (lx, H - 82)], fill=CHALK_DIM, width=1)

# Impact scale notation — right edge
scale_labels = ["low context", "moderate", "high stakes", "decisive"]
for i, sl in enumerate(scale_labels):
    sy = H - 200 - i * 60
    draw.text((W - 160, sy), sl, fill=CHALK_FAINT, font=font_mono_sm)
    draw.line([(W - 170, sy + 6), (W - 163, sy + 6)], fill=CHALK_FAINT, width=1)


# === LAYER 8: Central accent — the "impact = context × contribution" equation ===
# Rendered as a subtle, large typographic element — visible but not dominant

# Position it in the negative space, upper center-right area
eq_x, eq_y = 850, 145
eq_font_lg = load_font("Italiana-Regular.ttf", 48)
eq_font_op = load_font("Jura-Light.ttf", 34)
eq_font_sm = load_font("Italiana-Regular.ttf", 40)
eq_color = "#222b48"
eq_op_color = "#2a3450"

draw.text((eq_x, eq_y), "impact", fill=eq_color, font=eq_font_lg)
draw.text((eq_x + 215, eq_y + 12), "=", fill=eq_op_color, font=eq_font_op)
draw.text((eq_x + 265, eq_y + 4), "context", fill=eq_color, font=eq_font_sm)
draw.text((eq_x + 475, eq_y + 12), "\u00d7", fill=eq_op_color, font=eq_font_op)
draw.text((eq_x + 520, eq_y + 4), "contribution", fill=eq_color, font=eq_font_sm)

# Thin underline beneath the equation
draw.line([(eq_x, eq_y + 58), (eq_x + 720, eq_y + 58)], fill="#1a2040", width=1)


# === LAYER 9: Density clusters — concentrated mark fields at focal points ===

# Batting crisis zone — tight concentric dots
for _ in range(200):
    angle = random.uniform(0, 2 * math.pi)
    r = random.gauss(0, 60)
    x = 480 + r * math.cos(angle)
    y = 520 + r * 0.7 * math.sin(angle)
    if 80 < x < W - 80 and 80 < y < H - 80:
        s = 1
        draw.ellipse([x-s, y-s, x+s, y+s], fill=AMBER)

# Bowling spell zone — linear accumulation
for _ in range(150):
    x = 1500 + random.gauss(0, 80)
    y = 600 + random.gauss(0, 40)
    if 80 < x < W - 80 and 80 < y < H - 80:
        s = 1
        draw.ellipse([x-s, y-s, x+s, y+s], fill=TEAL)

# Match climax — vermillion concentration
for _ in range(120):
    x = 1900 + random.gauss(0, 50)
    y = 400 + random.gauss(0, 50)
    if 80 < x < W - 80 and 80 < y < H - 80:
        s = random.choice([1, 1, 2])
        draw.ellipse([x-s, y-s, x+s, y+s], fill=VERMILLION)


# === LAYER 10: Fine reference marks — specimen catalog feel ===

# Cross-hairs at focal points with connecting leader lines
focal_labels = [
    (480, 520, "entry difficulty", -1),
    (1500, 600, "economy containment", -1),
    (1900, 400, "match outcome", 1),
]
for fx, fy, label, direction in focal_labels:
    # Crosshair
    ch_len = 18
    draw.line([(fx - ch_len, fy), (fx - 6, fy)], fill=CHALK_DIM, width=1)
    draw.line([(fx + 6, fy), (fx + ch_len, fy)], fill=CHALK_DIM, width=1)
    draw.line([(fx, fy - ch_len), (fx, fy - 6)], fill=CHALK_DIM, width=1)
    draw.line([(fx, fy + 6), (fx, fy + ch_len)], fill=CHALK_DIM, width=1)
    # Small corner brackets
    bk = 8
    for dx, dy in [(-1, -1), (1, -1), (-1, 1), (1, 1)]:
        draw.line([(fx + dx*ch_len, fy + dy*ch_len),
                   (fx + dx*(ch_len - bk), fy + dy*ch_len)], fill=CHALK_FAINT, width=1)
        draw.line([(fx + dx*ch_len, fy + dy*ch_len),
                   (fx + dx*ch_len, fy + dy*(ch_len - bk))], fill=CHALK_FAINT, width=1)

    # Label with leader line
    lx = fx + 25
    ly = fy + 22
    draw.line([(fx + 8, fy + 8), (lx - 2, ly + 5)], fill=CHALK_FAINT, width=1)
    draw.text((lx, ly), label, fill=CHALK_DIM, font=font_mono_sm)

# === LAYER 11: Subtle wicket-fall markers along bottom ===
# Small triangles pointing up at wicket x-positions
for wx in wicket_positions:
    ty = H - 105
    draw.polygon([(wx, ty), (wx - 4, ty + 8), (wx + 4, ty + 8)], fill=VERMILLION)


# === Save ===
output_path = os.path.join(os.path.dirname(__file__), "blog-impact-header.png")
img.save(output_path, "PNG", quality=95)
print(f"Saved: {output_path}")
print(f"Dimensions: {W}x{H}")
