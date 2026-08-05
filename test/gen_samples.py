#!/usr/bin/env python3
"""Generate the sample vial images the end-to-end suite runs against.

The DPD images are not invented: they are painted with the MEASURED sRGB of the
Chlor-Test comparator card patches that the shipped 3.778 constant was fitted to
(calibration_dpd.csv), against a white reference at the same G=222.98 the fit used.
So driving the app with these images is a genuine round-trip — the app should
recover the concentration printed on the card patch.

The OTO images are painted from the calibration model in oto_calibration.json,
which is what the study fixed; they verify the app reproduces its own calibration
and, more importantly, that the total-vs-free guard rails fire.

Gate images (glare, missing white card, wrong reagent, colourless) exist to prove
the app REFUSES rather than guessing — the failure mode that matters in the field.
"""
import json
import os
import pathlib

from PIL import Image, ImageDraw, ImageFilter
import numpy as np

HERE = pathlib.Path(__file__).parent
OUT = HERE / "samples"
# Wipe first: fixtures are regenerated whenever the calibration changes, and a stale one
# left behind is silently tested against the new model.
if OUT.exists():
    for _f in OUT.iterdir():
        _f.unlink()
OUT.mkdir(exist_ok=True)

W, H = 400, 600
# Real white paper photographs at ~223, not 255. Using 255 would trip the app's own
# glare gate (>250 in all channels), so a realistic card is also the correct one.
WHITE = (223, 223, 223)
G_WHITE = 222.98  # the reference the DPD fit used

# card, mg/L, R, G, B  — measured medians from calibration_dpd.csv
DPD_CARD = [
    (0.10, 220.80, 208.80, 219.65),
    (0.20, 222.12, 199.12, 217.12),
    (0.30, 228.06, 185.06, 212.06),
    (0.50, 230.59, 168.59, 207.59),
    (0.75, 231.91, 138.56, 188.24),
    (1.00, 234.88, 121.59, 180.92),
]


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


def _card(cal):
    pts = cal["calibration_card"]["transmittance_vs_zero_patch"]
    return sorted((float(k), v) for k, v in pts.items())


def oto_T(conc, cal):
    """Inverse of the card lookup: the transmittance a given mg/L sits at."""
    P = _card(cal)
    A = [(c, np.log10(1 / t)) for c, t in P]
    for i in range(len(A) - 1):
        if conc <= A[i + 1][0]:
            f = (conc - A[i][0]) / (A[i + 1][0] - A[i][0])
            a = A[i][1] + f * (A[i + 1][1] - A[i][1])
            return 10 ** (-a)
    # past the top step: extend the last segment so over-range fixtures are reachable
    (c0, a0), (c1, a1) = A[-2], A[-1]
    a = a1 + (conc - c1) * (a1 - a0) / (c1 - c0)
    return 10 ** (-a)


def oto_rgb(conc, cal, ref=223.0):
    """A yellow whose BLUE channel puts it at the right place on the TWAD card."""
    b = ref * oto_T(conc, cal)
    r = min(252.0, ref + 30 * (1 - b / ref))
    g = max(b + 25.0, ref - 22 * (1 - b / ref))
    return (r, g, b)


def oto_conc(t, cal):
    """Forward card lookup — must match aquasafe.js concFromT exactly."""
    P = _card(cal)
    A = [(c, np.log10(1 / tt)) for c, tt in P]
    a = np.log10(1 / max(t, 1e-6))
    if a <= 0:
        return 0.0
    for i in range(len(A) - 1):
        if a <= A[i + 1][1]:
            f = (a - A[i][1]) / (A[i + 1][1] - A[i][1])
            return A[i][0] + f * (A[i + 1][0] - A[i][0])
    return A[-1][0]


def main():
    cal = json.loads((HERE / "oto_calibration.json").read_text())
    
    manifest = []

    for i, (conc, r, g, b) in enumerate(DPD_CARD):
        name = f"dpd_{str(conc).replace('.', 'p')}.png"
        vial(WHITE, (r, g, b), seed=i).save(OUT / name)
        # what the app must report: 3.778 * log10(G_white / G_patch)
        manifest.append({
            "file": name, "reagent": "dpd", "use": "drinking",
            "expect": "value", "expect_mg_l": round(3.778 * np.log10(G_WHITE / g), 3),
            "tol": 0.06, "card_mg_l": conc,
            "why": f"Chlor-Test card patch printed {conc} mg/L, measured sRGB from the fitted calibration set",
        })

    # The app gates on transmittance, so the fixtures must be built against the same
    # quantity — a fixture pinned to an absolute code would silently stop testing the
    # gate the moment the white reference changed.
    gate_t = cal["range"]["transmittance_gate"]
    gate_b = gate_t * 223.0
    for i, conc in enumerate(cal["test_points_mg_l"]):
        name = f"oto_{str(conc).replace('.', 'p')}.png"
        r, g, b = oto_rgb(conc, cal)
        vial(WHITE, (r, g, b), seed=100 + i).save(OUT / name)
        manifest.append({
            "file": name, "reagent": "oto", "use": "drinking",
            "expect": "value", "expect_mg_l": round(oto_conc(b / 223.0, cal), 3),
            "tol": 0.08, "card_mg_l": conc,
            "why": f"OTO yellow synthesised at {conc} mg/L total chlorine from the calibrated model",
            "must_not_pass": True,
        })

    # Over-range: the blue channel has flattened, so the app must publish a LOWER BOUND
    # rather than the (badly low) number the linear model would produce. This is the
    # false-safe failure the whole gate exists to prevent, so it gets its own case.
    for conc in cal["over_range_test_points_mg_l"]:
        name = f"oto_over_{str(conc).replace('.', 'p')}.png"
        r, g, b = oto_rgb(conc, cal)
        assert b < gate_b, f"{conc} mg/L gives B={b:.0f}, not past the gate at {gate_b:.0f}"
        vial(WHITE, (r, g, b), seed=150 + int(conc * 10)).save(OUT / name)
        manifest.append({
            "file": name, "reagent": "oto", "use": "drinking",
            "expect": "overrange",
            # the bound the app should publish: the concentration the gate corresponds to
            "expect_bound_mg_l": round(oto_conc(gate_t, cal), 3), "tol": 0.08,
            "card_mg_l": conc,
            "why": f"{conc} mg/L drives blue to {b:.0f} (T={b/223:.2f}), past the T={gate_t} "
                   f"saturation gate - "
                   f"must report a lower bound, never a number",
        })

    # ---- gate images: the app must REFUSE, not guess -------------------------
    gates = []

    # Below the camera detection floor, a faint OTO yellow is not separable from white
    # paper. Refusing is the only safe answer: this is exactly the concentration band
    # where inventing a number would produce a false pass.
    for conc in cal["below_floor_test_points_mg_l"]:
        name = f"oto_faint_{str(conc).replace('.', 'p')}.png"
        vial(WHITE, oto_rgb(conc, cal), seed=170 + int(conc * 100)).save(OUT / name)
        gates.append((name, "oto", "yellow vial detected",
                      f"{conc} mg/L is below the ~{cal['range']['camera_detection_floor_mg_l']} "
                      f"mg/L camera floor - too faint to separate from white paper"))
    # rename: the message is reagent-agnostic now that the app detects the reagent itself
    gates[-1] = (gates[-1][0], gates[-1][1], "No test vial found", gates[-1][3])

    # 1. Glare — >15% of the frame blown out to near-white.
    im = vial(WHITE, DPD_CARD[3][1:], seed=200)
    d = ImageDraw.Draw(im)
    d.ellipse([120, 60, 300, 300], fill=(255, 255, 255))
    im.save(OUT / "gate_glare.png")
    gates.append(("gate_glare.png", "dpd", "glare", "Blown-out highlight over 15% of the frame"))

    # 2. No white reference — vial photographed on a dark bench.
    vial((70, 74, 78), DPD_CARD[3][1:], seed=201).save(OUT / "gate_no_white.png")
    gates.append(("gate_no_white.png", "dpd", "white reference",
                  "Dark background, so no measured white to normalise against"))

    # 3. Auto-detection: a yellow vial is an OTO test whatever was selected before. The
    #    app reads the reagent off the colour, so this can no longer be a "wrong reagent"
    #    error - it must simply be measured as OTO.
    r, g, b = oto_rgb(1.0, cal)
    vial(WHITE, (r, g, b), seed=202).save(OUT / "autodetect_yellow.png")
    manifest.append({
        "file": "autodetect_yellow.png", "reagent": "oto", "use": "drinking",
        "expect": "value", "expect_mg_l": round(oto_conc(b / 223.0, cal), 3), "tol": 0.08,
        "card_mg_l": 1.0,
        "why": "A yellow vial must be recognised as OTO with no reagent selection at all",
    })

    # 4. Colourless sample. This is the dangerous one: zero chlorine and a blank vial
    #    look identical to a camera, so the app must refuse rather than report 0.00.
    vial(WHITE, (221, 221, 222), seed=203).save(OUT / "gate_colourless.png")
    gates.append(("gate_colourless.png", "dpd", "No test vial found",
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
