#!/usr/bin/env python3
"""Generate the sample vial images the end-to-end suite runs against.

Since 2026-09-11 both reagents are read against the 0-5 mg/L colour charts recorded in
chart_calibration.json, so the fixtures are painted from those charts: a vial showing
swatch i on a card of brightness WHITE has colour t_i x WHITE, where t_i is the swatch's
per-channel ratio to the chart's own 0.0 block. Driving the app with these images is a
genuine round trip — it should recover the mg/L printed under the swatch.

Gate images (glare, missing white card, colourless, too faint) exist to prove the app
REFUSES rather than guessing — the failure mode that matters in the field.
"""
import json
import os
import pathlib

from PIL import Image, ImageDraw, ImageFilter
import numpy as np

HERE = pathlib.Path(__file__).parent
OUT = HERE / "samples"
if OUT.exists():
    for _f in OUT.iterdir():
        _f.unlink()
OUT.mkdir(exist_ok=True)

W, H = 400, 600
# Real white paper photographs at ~223, not 255. Using 255 would trip the app's own
# glare gate (>250 in all channels), so a realistic card is also the correct one.
WHITE = (223, 223, 223)

CAL = json.loads((HERE / "chart_calibration.json").read_text())
STEPS = CAL["steps_mg_l"]


def chart_t(rg):
    rgb = CAL["swatch_rgb"][rg]
    w = rgb[0]
    return [[min(1.0, c / wc) for c, wc in zip(sw, w)] for sw in rgb]


def t_at(rg, conc):
    """Transmittance triple at any mg/L: linear between swatches, extended past 5.0."""
    T = chart_t(rg)
    for i in range(len(STEPS) - 1):
        if conc <= STEPS[i + 1]:
            f = (conc - STEPS[i]) / (STEPS[i + 1] - STEPS[i])
            return [a + f * (b - a) for a, b in zip(T[i], T[i + 1])]
    f = (conc - STEPS[-2]) / (STEPS[-1] - STEPS[-2])
    return [max(0.0, a + f * (b - a)) for a, b in zip(T[-2], T[-1])]


def rgb_at(rg, conc, white=WHITE):
    return tuple(t * w for t, w in zip(t_at(rg, conc), white))


def vial(bg, fluid, noise=1.5, seed=0, vial_box=(150, 140, 250, 470)):
    """Paint a vial of `fluid` colour standing on a `bg` card.

    Geometry matters: the app reads the central 30-70% horizontal band, so the vial
    must sit inside it and leave white card visible in the same band for the
    reference. A vial that filled the band would leave nothing to normalise against.
    """
    rng = np.random.default_rng(seed)
    im = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = vial_box
    d.rounded_rectangle([x0, y0, x1, y1], radius=16, fill=tuple(int(round(c)) for c in fluid))
    # glass wall highlight + meniscus, so the median has to survive real structure
    d.line([x0 + 6, y0 + 10, x0 + 6, y1 - 10], fill=tuple(min(255, int(c * 1.12)) for c in fluid), width=3)
    d.ellipse([x0, y0 - 8, x1, y0 + 8], fill=tuple(min(255, int(c * 1.06)) for c in fluid))
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    a = np.asarray(im).astype(np.float32)
    a += rng.normal(0, noise, a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def main():
    manifest = []

    for i, conc in enumerate(STEPS[1:], 1):
        name = f"dpd_{str(conc).replace('.', 'p')}.png"
        vial(WHITE, rgb_at('dpd', conc), seed=i).save(OUT / name)
        manifest.append({
            "file": name, "reagent": "dpd", "use": "drinking",
            "expect": "value", "expect_mg_l": conc, "tol": 0.06, "card_mg_l": conc,
            "why": f"DPD colour chart swatch printed {conc} mg/L, painted as its ratio to the chart white",
        })

    for i, conc in enumerate(STEPS[1:] + [0.6, 1.5], 1):
        name = f"oto_{str(conc).replace('.', 'p')}.png"
        vial(WHITE, rgb_at('oto', conc), seed=100 + i).save(OUT / name)
        manifest.append({
            "file": name, "reagent": "oto", "use": "drinking",
            # Between 3.0 and 4.0 the OTO chart moves only ~17 codes of green, so a
            # fixture's own noise is worth ~0.1 mg/L there: that is the chart's resolution.
            "expect": "value", "expect_mg_l": conc, "tol": (0.12 if conc >= 3.0 else 0.08), "card_mg_l": conc,
            "why": (f"OTO colour chart swatch printed {conc} mg/L" if conc in STEPS
                    else f"{conc} mg/L interpolated between the neighbouring OTO swatches"),
            "must_not_pass": True,
        })

    # Over range: darker than the 5.0 swatch along the last chart segment. The app must
    # publish 5.0 as a LOWER BOUND and ask for dilution, never a number past the chart.
    for conc in (6.0, 8.0):
        name = f"oto_over_{str(conc).replace('.', 'p')}.png"
        vial(WHITE, rgb_at('oto', conc), seed=150 + int(conc * 10)).save(OUT / name)
        manifest.append({
            "file": name, "reagent": "oto", "use": "drinking",
            "expect": "overrange", "expect_bound_mg_l": STEPS[-1], "tol": 0.08, "card_mg_l": conc,
            "why": f"{conc} mg/L is past the 5.0 swatch - must report a lower bound, never a number",
        })

    gates = []
    # Too faint to separate from white paper on the OTO tab: refuse, never invent a number.
    vial(WHITE, rgb_at('oto', 0.08), seed=178).save(OUT / "oto_faint_0p08.png")
    gates.append(("oto_faint_0p08.png", "oto", "No yellow vial found",
                  "0.08 mg/L is below the camera floor - too faint to separate from white paper"))

    # 1. Glare — >15% of the frame blown out to near-white.
    im = vial(WHITE, rgb_at('dpd', 1.0), seed=200)
    d = ImageDraw.Draw(im)
    d.ellipse([120, 60, 300, 300], fill=(255, 255, 255))
    im.save(OUT / "gate_glare.png")
    gates.append(("gate_glare.png", "dpd", "glare", "Blown-out highlight over 15% of the frame"))

    # 2. No white reference — vial photographed on a dark bench.
    vial((70, 74, 78), rgb_at('dpd', 1.0), seed=201).save(OUT / "gate_no_white.png")
    gates.append(("gate_no_white.png", "dpd", "white reference",
                  "Dark background, so no measured white to normalise against"))

    # 3. A yellow vial on the OTO tab reads as OTO at the 1.0 swatch.
    vial(WHITE, rgb_at('oto', 1.0), seed=202).save(OUT / "autodetect_yellow.png")
    manifest.append({
        "file": "autodetect_yellow.png", "reagent": "oto", "use": "drinking",
        "expect": "value", "expect_mg_l": 1.0, "tol": 0.08, "card_mg_l": 1.0,
        "why": "A yellow vial on the OTO tab reads at the 1.0 swatch",
    })

    # 4. Colourless sample: zero chlorine and a blank vial look identical to a camera,
    #    so the app must refuse rather than report 0.00.
    vial(WHITE, (221, 221, 222), seed=203).save(OUT / "gate_colourless.png")
    gates.append(("gate_colourless.png", "dpd", "No pink vial found",
                  "Colourless vial - indistinguishable from an empty one, must not be reported as a zero"))

    for f, reagent, needle, why in gates:
        manifest.append({"file": f, "reagent": reagent, "use": "drinking",
                         "expect": "reject", "reject_contains": needle, "why": why})

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {len(manifest)} sample images to {OUT}")
    for m in manifest:
        if m["expect"] == "value":
            tail = f"-> {m['expect_mg_l']} mg/L (card {m['card_mg_l']})"
        elif m["expect"] == "overrange":
            tail = f"-> OVER RANGE, bound >{m['expect_bound_mg_l']} mg/L (true {m['card_mg_l']})"
        else:
            tail = f"-> REJECT [{m['reject_contains']}]"
        print(f"  {m['file']:26s} {m['reagent']:4s} {tail}")


if __name__ == "__main__":
    main()
