#!/usr/bin/env python3
"""Fit k_OTO from a photograph of an OTO comparator card.

Every source consulted for the calibration study agreed on one thing: no standard and
no classical paper publishes an absorbance-per-mg/L for the o-tolidine yellow product.
JIS K 0106 Annex A, IS 3025 (Part 26), the Standard Methods lineage and the field kits
all say the same — *construct a calibration curve*. So k_OTO cannot be looked up. It has
to be fitted, exactly the way the shipped DPD constant 3.778 was fitted against a
photographed Chlor-Test card.

This is that tool. Point it at a photo of an OTO comparator card (Lovibond 3/2A, a
PHED / Jal Jeevan field kit card, or a pool OTO kit) plus the concentrations printed on
the patches, and it samples the patches, fits through the origin and writes
oto_calibration.json with the fit, its residuals and its honest range.

    python3 fit_oto_calibration.py card.jpg --steps 0.1,0.2,0.3,0.5,0.75,1.0 \
        --patches auto --white auto

IMPORTANT — read before trusting the output:

* Photograph the CARD, in even daylight, with a white reference in the same frame.
  Never sample hex values from artwork: rendered swatches like `gold` (255,215,0) have
  B=0, which makes log10(B_white/B_sample) infinite. Printed cards photographed under
  real light do not.
* A comparator card is a printed approximation of a vial. Fitting against photographs of
  REAL vials at chlorine concentrations standardised by titration is strictly better, and
  this tool accepts those too (--mode vials with one image per known concentration).
* The fit is only valid for the vial path length it was made with. Lovibond's Comparator
  2000+ cell is 13.5 mm; a 10 mL test tube is not.
"""
import argparse
import json
import pathlib
import sys

import numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).parent


def median_rgb(arr):
    return np.median(arr.reshape(-1, 3), axis=0)


def sample_patches(img, n, white_box=None):
    """Split the card into n equal horizontal patches and take a clean median of each.

    The inner 50% of each patch is used so printed step labels, borders and the gutter
    between patches cannot drag the median.
    """
    a = np.asarray(img.convert("RGB")).astype(np.float64)
    h, w, _ = a.shape
    out = []
    for i in range(n):
        x0, x1 = int(i * w / n), int((i + 1) * w / n)
        pw, ph = x1 - x0, h
        blk = a[int(ph * 0.25):int(ph * 0.55), x0 + int(pw * 0.25):x1 - int(pw * 0.25)]
        out.append(median_rgb(blk))
    if white_box:
        x0, y0, x1, y1 = white_box
        white = median_rgb(a[y0:y1, x0:x1])
    else:
        # Brightest, most neutral 1% of the frame is the paper.
        flat = a.reshape(-1, 3)
        neutral = flat[(flat.max(1) - flat.min(1)) < 18]
        if len(neutral) < 100:
            sys.exit("No neutral white region found — include white paper in the frame, "
                     "or pass --white x0,y0,x1,y1.")
        white = np.median(neutral[neutral.min(1) > np.percentile(neutral.min(1), 99)], axis=0)
    return np.array(out), white


def fit_through_origin(A, conc):
    """k = sum(A*c)/sum(A^2) — the same origin-forced least squares used for DPD.

    Forced through the origin because zero chlorine must mean zero absorbance: an
    intercept would let the app report chlorine from a colourless vial.
    """
    A, conc = np.asarray(A, float), np.asarray(conc, float)
    k = float((A * conc).sum() / (A * A).sum())
    pred = k * A
    ss_res = float(((conc - pred) ** 2).sum())
    ss_tot = float(((conc - conc.mean()) ** 2).sum())
    return k, (1 - ss_res / ss_tot if ss_tot else float("nan")), pred


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image", help="photo of the comparator card (or, with --mode vials, a directory)")
    p.add_argument("--steps", required=True, help="comma-separated mg/L printed on the patches, left to right")
    p.add_argument("--white", default="auto", help="x0,y0,x1,y1 of a white-paper region, or auto")
    p.add_argument("--card", default="unnamed OTO comparator card")
    p.add_argument("--path-length-mm", type=float, default=None, help="vial path length the card is read against")
    p.add_argument("--out", default=str(HERE / "oto_calibration.json"))
    a = p.parse_args()

    steps = [float(s) for s in a.steps.split(",")]
    white_box = None if a.white == "auto" else tuple(int(v) for v in a.white.split(","))
    patches, white = sample_patches(Image.open(a.image), len(steps), white_box)

    b_white = float(white[2])
    rows, A, keep = [], [], []
    for conc, rgb in zip(steps, patches):
        b = float(rgb[2])
        if b <= 1:
            print(f"  !! {conc} mg/L patch has B={b:.0f} — absorbance is undefined, dropping it. "
                  f"This is artwork, not a photograph.")
            continue
        absorb = float(np.log10(b_white / b))
        rows.append({"conc_mg_l": conc, "R": float(rgb[0]), "G": float(rgb[1]), "B": b,
                     "absorbance": round(absorb, 6)})
        A.append(absorb); keep.append(conc)

    if len(A) < 3:
        sys.exit("Need at least 3 usable patches to fit.")

    k, r2, pred = fit_through_origin(A, keep)
    for row, pr in zip(rows, pred):
        row["fit_origin"] = round(float(pr), 6)
        row["resid_origin"] = round(float(row["conc_mg_l"] - pr), 6)

    out = {
        "k_oto": round(k, 4),
        "r_squared": round(r2, 5),
        "b_white": round(b_white, 2),
        "fitted_range_mg_l": [min(keep), max(keep)],
        "source": a.card,
        "path_length_mm": a.path_length_mm,
        "method": "total chlorine mg/L = k_oto * log10(B_white / B_sample), least squares "
                  "forced through the origin, on gamma-encoded sRGB blue medians",
        "points": rows,
    }
    pathlib.Path(a.out).write_text(json.dumps(out, indent=2))
    print(f"\nk_OTO = {k:.4f}   R^2 = {r2:.4f}   over {min(keep)}-{max(keep)} mg/L")
    print(f"written to {a.out}")
    print("\nSanity checks before you ship this:")
    print("  * residuals should be small and unstructured — a systematic curve means the")
    print("    response is saturating and the top patches must be dropped from the fit")
    print("  * B at the top patch should stay above ~120; below that the blue channel")
    print("    flattens and the fit will extrapolate badly")


if __name__ == "__main__":
    main()
