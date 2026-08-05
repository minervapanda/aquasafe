# Aquasafe — DPD &amp; OTO chlorine field test

**Live app → https://minervapanda.github.io/aquasafe/**

Photograph a chlorine test vial against a sheet of white paper; Aquasafe reads the colour,
reports mg/L, stamps the photo with time and coordinates, and generates a one-page PDF
report. It installs to the home screen and runs offline.

It is the DPD/OTO chlorine test from
[water-quality-tools](https://github.com/minervapanda/water-quality-tools) split into its
own site, with two additions: **OTO reagent support** and **PDF report download**.

| | DPD (No. 1) | OTO (orthotolidine) |
|---|---|---|
| Colour | pink | yellow |
| Channel read | green | blue |
| Measures | **free** chlorine | **total** chlorine (free + combined) |
| Calibrated range | 0.1 – 1.0 mg/L, fitted | 0.2 – 3 mg/L, **provisional ±40 %** |
| Can demonstrate compliance? | yes | **no** — see below |

## The one thing to understand before using OTO

DPD No. 1 measures **free** chlorine — the fraction that actually disinfects, and the
quantity every drinking-water and pool standard is written against.

OTO measures **total** chlorine: free chlorine *plus* chloramines. Those two numbers are
not interchangeable, and the difference is not a rounding error. A sample reading
0.6 mg/L total is equally consistent with 0.6 mg/L free chlorine (fine) and 0.0 mg/L free
chlorine with 0.6 mg/L of chloramines (no disinfection at all). Total chlorine is an
**upper bound** on free chlorine and nothing more.

So Aquasafe enforces an invariant: **an OTO reading is never rendered as a pass.** It can
return exactly three things —

* **zero** → critical alert. This inference *is* sound: total zero means free zero.
* **over the guideline** → a caution. Raising an alarm on an upper bound is safe.
* **indeterminate** → everything else, with the caveat shown in the result, in the stamped
  photo and in the PDF.

Only DPD can produce a "within range" verdict. That is deliberate and is covered by a test
that sweeps every concentration in both use profiles and fails if any OTO reading ever
bands as `ok`.

## How the measurement works

Both reagents use the same idea. The coloured product absorbs light in one band; the app
measures how much darker the vial is than a white reference **in the same photograph**, so
per-channel camera gain and auto white balance cancel out:

```
A    = log10(V_white / V_sample)        V = median 8-bit channel value
mg/L = k × A × dilution
```

DPD-pink absorbs around 510 nm, so the **green** channel is read with **k = 3.778**, fitted
through the origin on six photographed Chlor-Test comparator patches spanning 0.1–1.0 mg/L
(R² = 0.995). That path is numerically identical to the shipped PoolCheck and AquaTreat
apps, so results stay comparable across the family.

OTO-yellow absorbs around 438 nm, so the **blue** channel is read, with a **provisional**
k = 4.0. See [Calibration](#calibration) for where that number comes from and how far it
can be trusted — the short version is ±40 %, which is why OTO readings are shown as an
interval (`0.61 mg/L, provisional range 0.44–0.86`) rather than a bare figure.

### Why the reference is picked before the colour

There is one subtlety that is easy to get backwards, and getting it backwards produces a
confident wrong number rather than an obvious failure.

The natural implementation — the one the DPD app uses — calls a pixel *white* when it is
bright and near-neutral, and *sample* when it matches the reagent's hue. That is sound for
DPD, because pink is magenta-ward and **no illuminant makes white paper look magenta**: the
pink axis is orthogonal to colour temperature.

It is unsound for OTO, because "yellow" **is** the warm end of the colour-temperature axis.
Under a warm cast, white-card pixels satisfy the yellow test, get counted as sample, and
drag the sample median up onto the card. Simulated at a 20-code warm cast, the reading
*freezes* near 0.18 mg/L across a true range of 0.30–0.75 mg/L — with every quality gate
still passing, because the one-sided selection manufactures exactly the channel ordering a
hue check looks for.

So Aquasafe inverts the order. It picks the white reference by **brightness in the
measuring channel alone** — a single-channel test never compares channels, so a colour cast
cannot fool it, and the analyte is by definition darker in the channel it absorbs — then
white-balances the frame by that reference, and only then applies the hue tests, which are
cast-invariant once the card is neutral by construction.

### What the app refuses to do

The failure mode that matters in the field is a confident wrong number, so the gates are
deliberately strict, and the **same gate runs on the live preview and on uploaded photos** —
an upload cannot bypass a check the camera path applies.

| Condition | Behaviour |
|---|---|
| No white card in frame | Refuses. The reference is never assumed — only measured. |
| Brightest thing in frame looks like sample, not card | Refuses. A vial on a dark bench is bright enough to pass a naive brightness floor; normalising by it would make the sample neutral and the reading vanish. |
| White card clipped at 255 | Refuses. A saturated reference has lost its own value, so every ratio against it reads **low** — the reassuring direction. |
| More than 15 % of the frame blown out | Refuses (glare). |
| No vial of the expected colour | Refuses. A colourless vial is **not** reported as 0.00 — an empty vial looks identical, so the app asks you to confirm zero on the comparator card. Below about 0.22 mg/L an OTO yellow is not separable from white paper, and that is also a refusal. |
| Vial is the *other* reagent's colour | Refuses and names the mismatch. |
| OTO vial absorbs red as well as blue | Refuses. Blue-green means under-acidified, stale, or stabilized-neutral reagent; orange-brown means chlorine in excess. Neither is on the calibration curve. |
| Transmittance at or below the saturation gate | Reports a **lower bound**, flagged, and asks for a dilution — never the (badly low) number the linear model would give. |
| OTO timer started but the photo is outside 4:30–10:00 | Refuses, because what OTO measures depends on when you read it. |
| Reagent switched after a reading | Clears the reading. Different channel, different constant, different species. |

The saturation gate is on **transmittance** (sample ÷ reference), not on the raw channel
value. An absolute code threshold looks camera-robust but is not: across the exposures the
app already accepts, a fixed blue floor of 125 fires anywhere between 0.32 and 1.24 mg/L, a
4× swing driven purely by exposure. Saturation is a ratio phenomenon, so the gate is a ratio.

## Calibration

`test/oto_calibration.json` holds the OTO constant, its full derivation, its sources, its
honest uncertainty and the record of what an adversarial review refuted. A test pins it to
the constants in `aquasafe.js` so the record and the code cannot drift apart.

**Read that file before trusting an OTO number.** The short version:

* No standard and no classical source publishes an absorbance-per-mg/L or a molar
  absorptivity for the o-tolidine yellow product. JIS K 0106 Annex A, IS 3025 (Part 26),
  the Standard Methods lineage and every field kit all say the same thing — *construct a
  calibration curve*. So k = 4.0 is **not a fit**. It is a reasoned prior.
* It was obtained by scaling the DPD constant 3.778 by the ratio of band-overlap ×
  stoichiometry × absorptivity. The ratio form is deliberate: sRGB gamma and the vial's
  effective path length cancel exactly, because both reagents go through the same
  photographic pipeline. A from-scratch derivation would have had to import both as
  assumptions.
* The load-bearing weakness is an **inferred** ε₄₃₈ ≈ 5 × 10⁴, bracketed 3.5–7 × 10⁴. Since
  k scales as 1/ε, that is ±40 % on the constant, and it straddles the 0.2 mg/L adequacy
  threshold in *both* directions. Hence the published interval.
* The blue channel does not bottom out on a strong yellow, it **plateaus**, because ~17 %
  of the channel's response sits where the dye barely absorbs. v1 fenced that off with a
  gate at ~1 mg/L and printed `>1.01` beyond it. **A field capture from Khordha, Odisha
  showed why that was the wrong call** — see below. The leak is now *corrected* rather
  than fenced off, `c = k(1−L)·log₁₀((1−L)/(T−L))` with L = 0.17, which leaves the low
  range untouched (under 0.02 mg/L drift) and moves the usable ceiling to ~3 mg/L. Past
  T = 0.21 (~4.4 mg/L) the dye has absorbed everything the channel can reach and the app
  still refuses a number.

### The Khordha capture

An operator photographed a real OTO vial in a translucent comparator block, backlit
through a window, and the app answered `>1.01 mg/L`. Their reply: *"It should show value
upto 3 ..but showing above 1."*

They were right, and the interesting part is that **nothing was wrong with the reading**.
The white reference resolved correctly to the block (B = 200, not the bright window), and
the capture geometry — backlit translucent block behind the vial — is a perfectly sound
diffuse-transmission setup. Transmittance came out at 0.23. The model computed a real
number and the gate threw it away.

Indian distribution water is routinely dosed to 2–3 mg/L, so a ceiling at 1 mg/L makes
the tool useless to the people it was built for. That frame now reads **3.79 mg/L, range
2.3–5.4+**, and lives in `test/field/` as a permanent regression test: if it ever returns
to reporting a bare lower bound, the suite fails.

The interval is wide, and honestly so — near the asymptote a small change in transmittance
moves the estimate a lot. That is what the interval is for, and it is why the fix for this
operator is not a better constant but **their own comparator card**: photograph it, run
`test/fit_oto_calibration.py`, and the ±40 % collapses.

To replace the prior with a real fit, `test/fit_oto_calibration.py` photographs an OTO
comparator card and fits through the origin exactly as the DPD constant was fitted.

### Known gaps, not fixed in v1

* **No sample blank.** Iron(III), tannin colour and turbidity all attenuate blue
  preferentially, so they pass the hue gate as legitimate yellow and can fabricate roughly
  0.05–0.2 mg/L of apparent total chlorine on chlorine-free water — straddling the decision
  threshold, in exactly the raw handpump water a PHED/JJM user is testing. The classical
  orthotolidine-arsenite procedure blanked this out. The fix is a paired photograph of the
  same vial *before* the reagent goes in; it changes the capture workflow, so it is v2.
* **Phone ISP colour matrices** are unmodelled and do not cancel in the DPD→OTO ratio, so
  the ~14 % cross-camera scatter is an underestimate of unknown size.

## Running the tests

The suite drives the real app in real Chrome over the real photo-upload path — the same
`<input type="file">` a field user taps — and asserts on rendered mg/L, refusal messages,
and the actual PDF bytes.

```bash
cd test
npm install                 # puppeteer-core; uses your installed Chrome
python3 gen_samples.py      # paints the sample vial images (seeded, reproducible)
node run_e2e.js             # or --headful to watch
node live_smoke.js          # same, against the deployed https site
```

The DPD sample images are painted with the **measured** sRGB of the comparator card patches
the 3.778 constant was fitted to, so the run is a genuine round trip: the app should recover
the concentration printed on the card. Generated PDFs land in `test/artifacts/` — open them.

## Files

```
index.html      UI
aquasafe.js     colorimetry, verdicts, log, stamping, report assembly
pdf.js          dependency-free PDF 1.4 writer (one page, base-14 fonts, embedded JPEG)
sw.js           offline shell — BUMP THE CACHE NAME ON EVERY DEPLOY
test/           sample-image generator + end-to-end suite
```

`pdf.js` is hand-rolled because the app must produce a report with the phone offline and no
CDN reachable, which rules out pulling in a PDF library.

## Limitations

Aquasafe is a **screening aid**, not a laboratory analysis.

* Consumer camera colorimetry is sensitive to lighting, white balance, turbidity and the
  vial's path length. The constants here were fitted against particular vials; a kit with a
  different cell will read differently.
* Turbid or coloured raw water biases both reagents.
* Read within about a minute. Both colours drift upward on standing as combined chlorine
  keeps developing; the OTO colour is also unstable past ~10 minutes.
* Confirm anything that drives a public-health decision against a comparator card or a bench
  photometer.

### OTO-specific

Aquasafe implements the classical **acid** o-tolidine test (final pH 1–3), whose product is
the yellow holoquinone. Three things follow that are easy to get wrong:

* **This is not IS 3025 (Part 26).** That Indian Standard codifies the *stabilized neutral*
  o-tolidine method — buffered to pH 6.5–7.5, stopping at the **blue** meriquinone, read at
  625 nm. A blue product absorbs in the *red* channel; this app would read it as almost
  nothing. Indian PHED / Jal Jeevan field kits use the acid chemistry, which is what is
  implemented here. The app's colour gate refuses anything that is not a clean yellow.
* **OTO reads low against a reference method** — roughly 90 % for inorganic chloramines, and
  as little as ~50 % for organic chloramines and real pool water. Combined with the total-
  vs-free problem, this is the second independent reason an OTO reading is never a pass.
* **Nitrite gives a false positive.** Around 0.05 mg/L NO₂-N develops colour equivalent to
  roughly 0.02 mg/L chlorine within minutes, and the artefact grows as the vial stands.

o-Tolidine is a suspect carcinogen. It was dropped from Standard Methods in 1975 on accuracy
grounds and the neutral variant in 1980 on toxicity, and it has been prohibited for
drinking-water testing in Japan since 2002. It remains in wide field use elsewhere, which is
why it is supported here. Handle per the kit instructions and **prefer DPD wherever you have
the choice**.

## Related

* [water-quality-tools](https://github.com/minervapanda/water-quality-tools) — AquaTreat
  (WTP operator toolkit) and PoolCheck (pool chlorine), the apps this one was split from.
