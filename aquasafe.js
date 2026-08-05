// Aquasafe — smartphone colorimetry for chlorine, DPD (free) and OTO (total).
//
// Lineage: this is PoolCheck's engine generalised over the reagent. The DPD path is
// numerically identical to the shipped PoolCheck/AquaTreat apps (same green-channel
// median, same 3.778, same white-reference gate) so results stay comparable across
// the family. OTO is the new path and reads the BLUE channel, because the OTO
// holoquinone is yellow and absorbs where DPD-pink transmits.

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
// Both constants live in the GAMMA-ENCODED sRGB domain — the log is taken on raw 8-bit
// medians, not linearised ones. That is legitimate: sRGB is a near-exact power law, so a
// ratio of encoded values is the encoded ratio and gamma only rescales k (constant within
// 2% from code 255 down to ~119). If anyone ever linearises the pipeline, BOTH constants
// must be divided by ~2.21 — shipping these against linearised values over-reports by 2.2x.
//
// DPD: fit through origin on a photographed Chlor-Test comparator card,
// A = log10(G_white/G_sample), 6 points 0.1-1.0 mg/L, R^2 = 0.995. Numerically identical
// to the shipped PoolCheck/AquaTreat apps. Standard Methods notes the DPD calibration goes
// non-linear above ~1.0 mg/L, which is exactly where the fitted card ends.
var DPD_K = 3.778;
var DPD_FIT_MAX = 1.0;
// Transmittance floor for DPD, set well past the fitted range (3.778*log10(1/0.09) =
// 3.95 mg/L) so ordinary readings behave exactly as in the shipped apps and only
// physically implausible ones are refused a number.
var DPD_SAT_T = 0.09;

// OTO: PROVISIONAL. See test/oto_calibration.json for the full derivation, the sources and
// the uncertainty — that file is the source of truth and a test asserts it matches these.
//
// There is no published molar absorptivity for the o-tolidine holoquinone; every standard
// says "construct a calibration curve". So this is NOT a fit, it is a reasoned prior with
// +/-40% on it, obtained by scaling 3.778 by the ratio of band-overlap x stoichiometry x
// absorptivity, which cancels sRGB gamma and vial path length because both sides share the
// same photographic pipeline. Replace it with test/fit_oto_calibration.py before OTO mode
// leaves beta.
//
// The near-equality with 3.778 is a real coincidence, not a copy-paste bug: OTO's larger
// absorptivity is almost exactly cancelled by its 1:1 (rather than 2:1) stoichiometry and
// its worse blue-channel overlap. Do not "fix" it.
var OTO_K = 4.0;
var OTO_FIT_MAX = 3.0;
// Gate on the CHANNEL CODE, not on computed mg/L: across a wide sweep of absorptivity and
// path length the +/-15% accuracy ceiling always lands at blue code 120-135, so the code
// gate is camera-robust in a way a concentration threshold is not. Below it the blue
// channel has flattened out on spectral leak and the model UNDER-reports — 2 mg/L reads as
// ~1.3, 5 mg/L reads as ~1.8. Under-reporting chlorine is the false-safe direction, which
// is why crossing this gate suppresses the number entirely instead of softening it.
// Transmittance floor. B/B_white = 0.56 is where the +/-15% accuracy ceiling lands
// across a wide sweep of absorptivity and path length, so it is the camera-robust form
// of the same threshold. At k=4.0 it corresponds to 4.0*log10(1/0.56) = 1.01 mg/L.
// The blue channel does NOT fall to zero on a strong yellow — it PLATEAUS, because
// ~17% of the channel's response sits where the 438 nm holoquinone barely absorbs. That
// unabsorbed leak acts as a stray-light floor, so a plain Beer model bends over and
// under-reads badly above ~1 mg/L.
//
// v1 handled that by refusing to print a number past the bend. A real capture from
// Khordha, Odisha showed why that is not good enough: Indian distribution water is
// routinely dosed to 2-3 mg/L, the app measured T=0.289 (a perfectly sound reading),
// and reported only ">1.01" — useless to the operator.
//
// So the leak is now CORRECTED rather than fenced off:
//     c = k(1-L) * log10((1-L)/(T-L))
// The (1-L) on k re-normalises so the low range is unchanged (within 2% of the linear
// model out to ~0.3 mg/L, where the constant was anchored) while the high range bends
// back up. T -> L is the true asymptote: there the dye has absorbed everything it can
// reach and no signal remains, which is where the gate now sits.
var OTO_LEAK = 0.17;
var OTO_SAT_T = 0.21;
// Device spread on the leak, used for the published interval. The full 28-camera range
// was 0.075-0.317; this is the central band. The extremes live in the calibration record.
var OTO_LEAK_LO = 0.12, OTO_LEAK_HI = 0.24;
// Both ends of the +/-40% bracket on k. The uncertainty straddles the 0.2 mg/L
// adequacy threshold, so every OTO number is published as an interval rather than a
// point: at the low end of the bracket a true 0.15 mg/L would display as 0.21 and
// appear to clear a line it does not clear.
var OTO_K_LO = 2.9, OTO_K_HI = 5.7;
var OTO_CAL_NOTE = 'Provisional constant (±40%), reasoned from the DPD calibration rather than fitted, with a leak correction above ~1 mg/L — usable 0.2–3 mg/L, refused past ~4.4.';

// The visual scale in the PHED "Orthotolidine (OTO) Total Chlorine Method" standard
// reference — the card the field operator is holding while they use this app. Reporting
// only a decimal number makes the app and the card talk past each other; naming the patch
// lets the operator cross-check the two in the field, which is the whole point of a
// screening aid. Note the printed patches leave gaps (0.5-1.0, 1.5-2.0, 3.0-4.0, 5.0-10),
// so a reading can legitimately fall between two patches and is reported that way.
var OTO_CARD = [
  { lo: 0.0, hi: 0.5, label: 'Clear / faint' },
  { lo: 1.0, hi: 1.5, label: 'Light yellow' },
  { lo: 2.0, hi: 3.0, label: 'Bright yellow' },
  { lo: 4.0, hi: 5.0, label: 'Dark yellow' },
  { lo: 10.0, hi: Infinity, label: 'Orange / brown' }
];
function otoCardBand(c) {
  var i, b;
  for (i = 0; i < OTO_CARD.length; i++) {
    b = OTO_CARD[i];
    if (c >= b.lo && c <= b.hi) {
      return b.label + ' patch (' + b.lo + (isFinite(b.hi) ? '–' + b.hi : '+') + ' mg/L)';
    }
  }
  for (i = 0; i < OTO_CARD.length - 1; i++) {
    if (c > OTO_CARD[i].hi && c < OTO_CARD[i + 1].lo) {
      return 'between the ' + OTO_CARD[i].label.toLowerCase() + ' and ' +
             OTO_CARD[i + 1].label.toLowerCase() + ' patches';
    }
  }
  return null;
}

var reagentId = 'dpd', useId = 'drinking';
var camStream = null, roiTimer = null, lastGeo = null, lastReading = null, lastResult = null;
var lastCapture = null;   // frozen copy of the captured frame, for re-stamping
var criticalShown = false;

// The app is used in both the US and India, so dates follow the device's REGION
// (7/24/2026 vs 24/07/2026) — but the language is pinned to English and digits to
// Latin. Without the pin, a phone set to Marathi/Bengali renders Devanagari digits,
// which no field record should contain.
var APP_LOCALE = (function () {
  try {
    var o = new Intl.DateTimeFormat().resolvedOptions();
    var region = (String(o.locale).match(/-([A-Za-z]{2})(?:-|$)/) || [])[1];
    if (region) region = region.toUpperCase();
    if (!region) {
      var tz = o.timeZone || '';
      region = /Kolkata|Calcutta/i.test(tz) ? 'IN' : (/America\//.test(tz) ? 'US' : '');
    }
    return 'en' + (region ? '-' + region : '') + '-u-nu-latn';
  } catch (e) { return 'en-u-nu-latn'; }
})();

function fmt(x, d) { if (x === null || !isFinite(x)) return '—'; return Number(x).toFixed(d); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function _median(a) { if (!a.length) return 0; a.sort(function (x, y) { return x - y; }); return a[a.length >> 1]; }
function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// Reagent profiles
// ---------------------------------------------------------------------------
// channel: index into the RGBA quad. DPD-pink absorbs ~510 nm -> read GREEN.
// OTO-yellow absorbs ~435 nm -> read BLUE.
var REAGENTS = {
  dpd: {
    id: 'dpd', name: 'DPD', colourWord: 'pink', channel: 1, channelName: 'green',
    species: 'free', speciesLabel: 'Free chlorine', shortLabel: 'Free Cl',
    get k() { return DPD_K; },
    get fitMax() { return DPD_FIT_MAX; },
    get satT() { return DPD_SAT_T; },
    leak: 0,   // DPD's green-channel leak is ~5% and its constant was fitted empirically
    leakLo: 0, leakHi: 0,
    segClass: 'pinkish',
    // pink: red-dominant with blue also above green (magenta-ward), never neutral grey
    isAnalyte: function (R, G, B) { return R > G + 8 && B > G + 2 && (R - G) > 10; },
    sop: ['Collect <b>10 mL</b> of sample in a clean clear vial.',
          'Add the <b>DPD No.1</b> reagent (tablet/powder, free chlorine); cap and invert until an even <b>pink</b> develops.',
          'Read <b>within 1 minute</b> — DPD colour fades and drifts toward total chlorine on standing.',
          'Hold the vial against a <b>pure white</b> card and fill the outline; tap the shutter.'],
    chips: ['1 · Fill 10 mL', '2 · Add DPD', '3 · Photograph', '4 · Result']
  },
  oto: {
    id: 'oto', name: 'OTO', colourWord: 'yellow', channel: 2, channelName: 'blue',
    species: 'total', speciesLabel: 'Total chlorine', shortLabel: 'Total Cl',
    get k() { return OTO_K; },
    get fitMax() { return OTO_FIT_MAX; },
    get satT() { return OTO_SAT_T; },
    get leak() { return OTO_LEAK; },
    get leakLo() { return OTO_LEAK_LO; },
    get leakHi() { return OTO_LEAK_HI; },
    segClass: 'yellowish',
    // yellow/amber: red and green both well above blue. Deep over-range samples run
    // orange to brown and still satisfy this — they are caught by the floor, not here.
    isAnalyte: function (R, G, B) { return (R - B) > 30 && (G - B) > 20 && R > 90 && G > 70; },
    // This is the classical ACID o-tolidine test (final pH 1–3), whose product is the
    // yellow holoquinone. It is NOT the stabilized-neutral variant codified in
    // IS 3025 (Part 26), which is buffered to pH 6.5–7.5 and stops at the BLUE
    // meriquinone read at 625 nm — that one absorbs in red, and this app would
    // read it as nothing at all. The colour gate is what keeps the two apart.
    sop: ['Collect <b>10 mL</b> of sample in a clean clear vial.',
          'Add the <b>acid OTO</b> reagent (usually 3–4 drops); cap and invert — a <b>yellow</b> colour develops.',
          'If the colour is <b>blue-green</b> the reagent is under-acidified or stale; if it is <b>orange/brown</b> the chlorine is in excess. Neither can be read — re-run or dilute.',
          'Photograph <b>immediately</b> after mixing — PHED protocol. Delay lets the colour keep rising and <b>over-reports</b> the residual.',
          'Hold the vial against a <b>pure white</b> card and fill the outline; tap the shutter.'],
    chips: ['1 · Fill 10 mL', '2 · Add OTO', '3 · Photograph', '4 · Result']
  }
};
function R() { return REAGENTS[reagentId]; }

// ---------------------------------------------------------------------------
// Use profiles (which standard applies)
// ---------------------------------------------------------------------------
var USES = {
  drinking: {
    id: 'drinking', label: 'Drinking water',
    // IS 10500:2012 requires >= 0.2 mg/L free residual at the consumer end when
    // chlorination is practised; WHO suggests 0.2-0.5 at delivery, <= 5 for health.
    min: 0.2, idealHigh: 1.0, max: 5.0,
    standard: 'IS 10500:2012 — min 0.2 mg/L free residual chlorine at the consumer end; WHO guideline 0.2–0.5 mg/L at delivery, health-based maximum 5 mg/L.',
    gaugeStops: ['0', '0.2', '0.5', '1', '5+'], gaugeMax: 5,
    gaugeCSS: 'linear-gradient(90deg,#e74c3c 0%,#e6842e 3%,#2ecc71 5%,#2ecc71 20%,#8fd18f 45%,#e6842e 80%,#e74c3c 100%)',
    zeroTitle: 'ZERO CHLORINE — WATER UNSAFE',
    zeroAdv: 'CRITICAL: no chlorine detected. This supply currently has no disinfection barrier against microbial contamination.<br><br>' +
             '<b>Immediate action:</b> check the chlorination/dosing equipment for failure, verify the chlorine demand of the raw water, and dose to restore a safe residual (≥0.2 mg/L free) before the water is consumed.'
  },
  pool: {
    id: 'pool', label: 'Swimming pool',
    min: 1.0, idealHigh: 3.0, max: 5.0,
    standard: 'WHO pool guidance 1–3 mg/L free chlorine; US CDC/MAHC ≥1 mg/L, raised to ≥2 mg/L where cyanuric-acid stabilizer is present (CYA max 90 mg/L).',
    gaugeStops: ['0', '1', 'ideal 1–3', '3', '5+'], gaugeMax: 5,
    gaugeCSS: 'linear-gradient(90deg,#e74c3c 0%,#e6842e 16%,#2ecc71 20%,#2ecc71 60%,#e6842e 72%,#e74c3c 100%)',
    zeroTitle: 'ZERO CHLORINE — POOL UNSAFE',
    zeroAdv: 'CRITICAL: no chlorine detected. The pool has no disinfection and is unsafe for bathers.<br><br>' +
             '<b>Immediate action:</b> close the pool to bathers, check the chlorinator/dosing pump, and re-chlorinate to restore 1–3 mg/L free chlorine before reopening.'
  }
};
function U() { return USES[useId]; }

// ---------------------------------------------------------------------------
// Image analysis
// ---------------------------------------------------------------------------
// Locate the coloured liquid in the central band and measure its absorbing channel
// against the white surround. Also counts the OTHER reagent's colour, so selecting
// the wrong reagent produces a specific error instead of "nothing detected".
function analyzeFrame(srcEl, w, h) {
  var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  var cx = cv.getContext('2d'); cx.drawImage(srcEl, 0, 0, w, h);
  return analyzePixels(cx.getImageData(Math.round(w * 0.30), 0, Math.round(w * 0.40), h).data);
}
// Split out so the test harness can drive the maths without a DOM canvas.
function analyzePixels(d) {
  var rg = R(), other = REAGENTS[rg.id === 'dpd' ? 'oto' : 'dpd'];
  var n = d.length / 4, i, Rr, Gg, Bb;

  // --- pass 1: find the white card WITHOUT looking at colour --------------------
  //
  // This ordering is the whole ballgame for OTO, and getting it wrong is a false-safe
  // failure rather than a wrong-by-a-bit one.
  //
  // The obvious approach — the one the DPD app uses — is to call a pixel "white" when
  // it is bright and near-neutral (max-min < 18), and "sample" when it matches the
  // reagent's hue. That is sound for DPD, because pink is magenta-ward and NO
  // illuminant makes white paper look magenta: the pink axis is orthogonal to colour
  // temperature. It is unsound for OTO, because "yellow" IS the warm end of the colour
  // temperature axis. Under a warm cast, white card pixels satisfy the yellow test,
  // get counted as sample, and drag the sample median up onto the card — at which
  // point the reading stops tracking concentration and freezes at a plausible-looking
  // number, with every quality gate still passing.
  //
  // So: pick the reference by brightness in the MEASURING CHANNEL ALONE, normalise the
  // frame by it so the card is neutral by construction, and only then apply the hue
  // tests. A single-channel brightness test never compares channels, so it cannot be
  // fooled by a colour cast.
  //
  // The measuring channel specifically, not luminance. Luminance is 72% green, so for a
  // faint OTO sample — which drops blue but leaves red and green slightly ABOVE the
  // card — the vial is the brightest thing in frame and luminance selects the vial as
  // its own reference, yielding a near-zero reading on real chlorine. In the measuring
  // channel that inversion cannot happen: the analyte is defined by absorbing there, so
  // it is always darker than the card in that channel.
  var ch0 = rg.channel;
  var hist = new Uint32Array(256), over = 0;
  for (i = 0; i < d.length; i += 4) {
    if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) over++;
    hist[d[i + ch0]]++;
  }
  var want = Math.max(50, Math.floor(n * 0.10)), acc = 0, thr = 255;
  for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= want) { thr = i; break; } }

  var wV = [[], [], []], nW = 0;
  for (i = 0; i < d.length; i += 4) {
    if (d[i + ch0] >= thr) { wV[0].push(d[i]); wV[1].push(d[i + 1]); wV[2].push(d[i + 2]); nW++; }
  }
  var white = [_median(wV[0]), _median(wV[1]), _median(wV[2])];
  var wMin = Math.min(white[0], white[1], white[2]), wMax = Math.max(white[0], white[1], white[2]);
  // The brightest thing in frame is only a usable reference if it is actually a bright
  // card AND not clipped. A clipped reference has lost its own value to saturation, so
  // every ratio against it is wrong in the reassuring direction.
  //
  // Brightness alone is not enough to say "this is the card". Photograph a vial on a
  // dark bench and the brightest thing in frame is the SAMPLE, whose median can clear a
  // plain brightness floor (a pink vial measures around 231/171/208 — its green squeaks
  // over 170). Normalising by that turns the sample neutral and the reading vanishes.
  //
  // So the chosen reference is checked against the analyte predicates themselves: if it
  // looks like either reagent's colour, it is sample, not card. This is a chroma test,
  // but it is applied to the RESULT rather than used to choose among candidates, so it
  // does not reintroduce the illuminant confound — a warm-cast card runs R >= G >= B,
  // which matches neither the magenta signature of DPD (green below both neighbours)
  // nor a saturated yellow.
  var looksLikeSample = REAGENTS.dpd.isAnalyte(white[0], white[1], white[2]) ||
                        REAGENTS.oto.isAnalyte(white[0], white[1], white[2]);
  var whiteOK = nW >= 50 && wMin > 170 && wMax <= 250 && !looksLikeSample;
  var clippedRef = nW >= 50 && wMax > 250;

  var minPix = Math.max(50, 0.02 * n);
  var ch = rg.channel;
  // No usable card -> ref = 0 (never a fabricated perfect white): a reading is only ever
  // computed against a MEASURED reference. This is the bug that was fixed across the
  // family on 2026-07-30 and must not regress.
  var ref = whiteOK ? white[ch] : 0;
  if (!whiteOK) {
    return { detected: false, overFrac: over / n, ref: 0, clippedRef: clippedRef,
             wrongReagent: false, otherName: other.name, otherColour: other.colourWord };
  }

  // --- pass 2: segment on WHITE-BALANCED values --------------------------------
  var kR = 255 / white[0], kG = 255 / white[1], kB = 255 / white[2];
  var sV = [[], [], []], nS = 0, nOther = 0;
  for (i = 0; i < d.length; i += 4) {
    var nr = d[i] * kR, ng = d[i + 1] * kG, nb = d[i + 2] * kB;
    if (rg.isAnalyte(nr, ng, nb)) { sV[0].push(d[i]); sV[1].push(d[i + 1]); sV[2].push(d[i + 2]); nS++; }
    else if (other.isAnalyte(nr, ng, nb)) nOther++;
  }
  if (nS < minPix) {
    return { detected: false, overFrac: over / n, ref: ref, clippedRef: false,
             wrongReagent: nOther >= minPix, otherName: other.name, otherColour: other.colourWord };
  }
  return { detected: true, sample: _median(sV[ch]), ref: ref, overFrac: over / n,
           clippedRef: false, wrongReagent: false, nSample: nS, nWhite: nW,
           offChannel: offChannelCheck(rg, sV, wV) };
}
// Off-chromophore guard.
//
// o-Tolidine has TWO coloured oxidation states, not one: the yellow holoquinone at
// ~438 nm that this method measures, and a BLUE meriquinone at ~630 nm that forms when
// the kit is under-acidified or when o-tolidine is in large excess over chlorine. Push
// it the other way — chlorine in excess — and you get orange/brown over-oxidation
// products instead. Both absorb strongly in RED, where the holoquinone does not, so a
// red absorbance that is a meaningful fraction of the blue one means the colour on
// screen is not the species the calibration describes. Reading it anyway would report
// a confident number off the wrong curve, biased LOW — the dangerous direction.
function offChannelCheck(rg, sV, wV) {
  if (rg.species !== 'total') return null;
  function A(c) {
    var s = Math.max(_median(sV[c]), 1), w = _median(wV[c]);
    return w > 0 ? Math.log10(w / s) : 0;
  }
  var aBlue = A(2), aRed = A(0);
  return { aRed: aRed, aBlue: aBlue,
           suspect: aBlue > 0.02 && aRed > 0.20 * aBlue && aRed > 0.04 };
}

function dilutionFactor() { return parseFloat($('dilution').value) || 1; }

// mg/L from the two channel medians. Shared by both reagents; only k and the channel
// differ. Returns an over-range flag rather than a silently huge number.
//
// The over-range gate is on TRANSMITTANCE (sample/reference), not on the raw channel
// code and not on the computed mg/L.
//
// Not mg/L: the concentration at which the response flattens depends on the dye's molar
// absorptivity and the vial path length, neither of which the app knows.
// Not the raw code either, which was the first attempt and is wrong: an absolute floor
// of 125 fires at 0.32 mg/L against a dim reference and 1.24 mg/L against a bright one,
// a 4x swing driven purely by exposure. Saturation is a ratio phenomenon, so the gate
// has to be a ratio to be exposure-independent.
function concFromT(T, rg, k, L) {
  k = (k == null) ? rg.k : k;
  L = (L == null) ? (rg.leak || 0) : L;
  if (!L) return Math.max(0, k * Math.log10(1 / Math.max(T, 1e-6)));
  return Math.max(0, k * (1 - L) * Math.log10((1 - L) / Math.max(T - L, 1e-6)));
}
function concFromChannel(sample, ref, dil, rg) {
  rg = rg || R();
  var T = ref > 0 ? Math.min(sample / ref, 1) : 1;
  var overRange = T <= rg.satT;
  // Clamping sample to ref keeps the reading non-negative (a vial brighter than the card
  // is noise, not negative chlorine) — but record it, because silently clamping is how a
  // saturated reading gets laundered into a confident one.
  var clamped = sample > ref;
  // Past the gate the dye has absorbed everything the channel can see, so the value at
  // the gate is published as a lower bound rather than a spuriously precise number.
  var conc = concFromT(Math.max(T, rg.satT), rg) * (dil || 1);
  return {
    A: Math.log10(1 / Math.max(T, 1e-6)), T: T, conc: conc,
    overRange: overRange, clamped: clamped,
    extrapolated: !overRange && conc / (dil || 1) > rg.fitMax,
    adviseDil: overRange || conc / (dil || 1) > rg.fitMax
  };
}
// Honest interval, swept over both uncertain parameters: the constant (+/-40%, because
// no molar absorptivity for the o-tolidine product is published anywhere) and the
// device-dependent leak. Both widen sharply near the asymptote, which is the point —
// a number quoted to two decimals at 3 mg/L would be false precision.
function concInterval(T, rg, dil) {
  if (!rg.leak) return null;                       // DPD is empirically fitted
  var ks = [OTO_K_LO, rg.k, OTO_K_HI], Ls = [rg.leakLo, rg.leak, rg.leakHi];
  var lo = Infinity, hi = 0, open = false;
  for (var i = 0; i < ks.length; i++) for (var j = 0; j < Ls.length; j++) {
    // A leak at or above the measured transmittance means that camera could not have
    // produced this frame at any finite concentration — the upper bound is open.
    if (T <= Ls[j] + 0.01) { open = true; continue; }
    var c = concFromT(T, rg, ks[i], Ls[j]) * (dil || 1);
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  if (!isFinite(lo)) return null;
  return { lo: lo, hi: hi, open: open };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
// SAFETY INVARIANT: an OTO reading may never render as a pass.
// OTO measures free + combined chlorine, so total >= free. A total of 0.6 mg/L is
// consistent with a free residual of 0.6 or of 0.0 — it cannot demonstrate that a
// free-residual floor is met. The only sound inference from OTO is downward: total
// zero implies free zero. So OTO returns 'zero' (critical), 'high' (a caution, which
// is safe to raise) or 'info' (indeterminate) — never 'ok'.
function classify(conc, rg, u, overRange) {
  rg = rg || R(); u = u || U();
  if (conc <= 0.049 && !overRange) return { band: 'zero', label: 'ZERO — unsafe', critical: true };

  if (rg.species === 'total') {
    if (overRange) return { band: 'high', label: 'Over range — dilute and re-test' };
    // 0.2 mg/L is where the blue channel stops being quantitative, not where the water
    // stops mattering. Saying "trace" is more honest than printing two decimals.
    if (conc < 0.2) return { band: 'info', label: 'Trace — below the quantitative floor' };
    return { band: 'info', label: 'Total chlorine — free residual not established' };
  }

  var cya = parseFloat($('cya') ? $('cya').value : '') || 0;
  var lo = u.min;
  if (u.id === 'pool' && cya > 0) lo = 2.0;      // MAHC 2023 stabilized minimum
  if (conc < lo) return { band: 'low', label: 'Low (<' + lo + ') — under-chlorinated' };
  if (conc <= u.idealHigh) return { band: 'ok', label: 'Within range (' + lo + '–' + u.idealHigh + ' mg/L)' };
  if (conc <= u.max) return { band: 'high', label: 'High (>' + u.idealHigh + ')' };
  return { band: 'vhigh', label: 'Very high (>' + u.max + ')' };
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function setReagent(id) {
  if (!REAGENTS[id]) return;
  reagentId = id;
  $('rgDpd').className = id === 'dpd' ? 'on' : '';
  $('rgOto').className = id === 'oto' ? 'on' : '';
  $('segReagent').className = 'seg ' + R().segClass;
  // Switching reagent invalidates any reading on screen — the maths, the channel and
  // the measured species all changed.
  clearResult('Reagent switched to ' + R().name + '. Capture a new test.');
  syncReagentUI();
}
function setUse(id) {
  if (!USES[id]) return;
  useId = id;
  $('useDrink').className = id === 'drinking' ? 'on' : '';
  $('usePool').className = id === 'pool' ? 'on' : '';
  $('cyaWrap').style.display = (id === 'pool') ? 'block' : 'none';
  syncReagentUI();
  rerender();
}
function syncReagentUI() {
  var rg = R(), u = U();
  $('sopBox').innerHTML = '<b>How to test — ' + rg.name + '</b><ol>' +
    rg.sop.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
  // Uniform, never highlighted. The chips are a printed procedure, not a progress
  // indicator — nothing advances them, so marking step 1 "current" told every user they
  // were at the start no matter where they actually were.
  $('stepChips').innerHTML = rg.chips.map(function (c) {
    return '<span>' + esc(c) + '</span>';
  }).join('');
  $('resultHeading').textContent = rg.speciesLabel;
  $('reagentNote').innerHTML = rg.id === 'dpd'
    ? 'DPD No.1 measures <b>free chlorine</b> — the fraction that actually disinfects, and the one the standards are written against.'
    : 'OTO measures <b>total chlorine</b> (free + combined). It cannot separate the two, so it can flag a zero or an excess but <b>cannot confirm</b> that a free-residual standard is met.';
  $('timerBox').style.display = (rg.species === 'total') ? 'block' : 'none';
  if (rg.species !== 'total') stopTimer();
  $('gauge').style.background = u.gaugeCSS;
  $('gaugeLbl').innerHTML = u.gaugeStops.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('');
  $('roiLabel').textContent = 'Align the ' + rg.colourWord + ' vial · white background';
  $('footNote').innerHTML = rg.id === 'dpd'
    ? 'DPD green-channel colorimetry · free chlorine = ' + DPD_K + ' × log₁₀(G<sub>white</sub>/G<sub>sample</sub>), R²=0.995, fitted 0.1–1.0 mg/L.<br>' + esc(u.standard) + '<br>A screening aid — confirm against the comparator card.'
    : 'OTO blue-channel colorimetry · total chlorine = ' + OTO_K + ' × log₁₀(B<sub>white</sub>/B<sub>sample</sub>). ' + esc(OTO_CAL_NOTE) + '<br>' + esc(u.standard) + '<br>A screening aid — confirm against the comparator card.';
}

// ---------------------------------------------------------------------------
// OTO reaction timer
// ---------------------------------------------------------------------------
// Acid OTO read at under ~15 s approximates FREE chlorine; read at 5 minutes it is
// TOTAL. Since this mode reports total, the time the photo was taken is part of the
// measurement, not a nicety. The timer is optional — a field user with a photo already
// on the phone can still get a reading — but an untimed reading is labelled as such
// everywhere it appears, and a timed one outside the window is refused.
// PHED's own standard reference is explicit: "Color development must be evaluated
// IMMEDIATELY after reagent mixing to prevent OVERESTIMATION of residual levels due to
// delayed reactions."
//
// An earlier version of this app enforced the classical Standard Methods convention
// instead — free chlorine at <15 s, total at 5 min — and REFUSED any photo before 4:30.
// That told a PHED operator to do the opposite of their own protocol, and per that
// protocol to over-report. The document wins: it is the procedure these users are
// trained on and audited against.
//
// So the timer never blocks an early read. It only flags a LATE one, which is the
// direction the protocol warns about. (The tension is real and is recorded in
// test/oto_calibration.json: reading immediately under-develops chloramines, so the
// value sits nearer free chlorine than total. That keeps "an upper bound on free
// chlorine" true, which is the claim the safety logic rests on.)
var OTO_LATE_WARN_S = 120, OTO_LATE_HARD_S = 600;
var otoTimerStart = null, otoTimerTick = null;
function toggleTimer() {
  if (otoTimerStart) { stopTimer(); return; }
  otoTimerStart = Date.now();
  $('timerBtn').textContent = '■ Reset';
  otoTimerTick = setInterval(paintTimer, 250);
  paintTimer();
}
function stopTimer() {
  otoTimerStart = null;
  if (otoTimerTick) { clearInterval(otoTimerTick); otoTimerTick = null; }
  $('timerBtn').textContent = '▶ Reagent added';
  $('timerFace').textContent = '—:—';
  $('timerFace').style.color = 'var(--grey)';
  $('timerNote').textContent = 'Optional, but a reading with no recorded reaction time is marked as such on the report.';
}
function elapsedS() { return otoTimerStart ? (Date.now() - otoTimerStart) / 1000 : null; }
function paintTimer() {
  var e = elapsedS(); if (e === null) return;
  var face = $('timerFace');
  face.textContent = Math.floor(e / 60) + ':' + ('0' + Math.floor(e % 60)).slice(-2);
  if (e <= OTO_LATE_WARN_S) {
    face.style.color = 'var(--green)';
    $('timerNote').textContent = 'Photograph now. PHED protocol: read immediately after mixing.';
  } else if (e <= OTO_LATE_HARD_S) {
    face.style.color = 'var(--amber)';
    $('timerNote').textContent = 'Over 2 minutes since mixing — the colour keeps rising, so the reading will run high. Photograph now and treat it as an over-estimate.';
  } else {
    face.style.color = 'var(--red)';
    $('timerNote').textContent = 'Over 10 minutes — the colour has drifted too far to read. Make a fresh test.';
  }
  if (typeof checkROI === 'function' && camStream) checkROI();
}
// Returns a rejection reason if the timer is running and we are outside the window.
function timingGate() {
  var rg = R(); if (rg.species !== 'total') return null;
  var e = elapsedS(); if (e === null) return null;
  // Never refuse an EARLY read — PHED asks for exactly that. Only a very late one is
  // refused, and that is the direction the protocol warns about.
  if (e > OTO_LATE_HARD_S) return { shortMsg: 'Over 10 minutes since mixing',
    longMsg: '<b>Too late to read.</b> ' + Math.floor(e / 60) + ' minutes have elapsed since the reagent went in. The OTO colour keeps rising for hours, so a reading this late over-reports — which is the error the PHED protocol warns about. Make a fresh test and photograph it straight away.' };
  return null;
}

function requestGeo() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    function (p) { lastGeo = { lat: p.coords.latitude, lon: p.coords.longitude }; },
    function () { lastGeo = null; }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}
function startCam() {
  stopCam();
  var v = $('cam'), hint = $('camHint');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    hint.innerHTML = '<span style="color:var(--red)">Camera not available — use 📁 Photo or the manual entry below.</span>'; return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function (s) {
      camStream = s; v.srcObject = s;
      hint.textContent = 'Fill the outline with the vial against white, then tap the shutter.';
      if (roiTimer) clearInterval(roiTimer);
      roiTimer = setInterval(checkROI, 400);
    })
    .catch(function () {
      hint.innerHTML = '<span style="color:var(--red)">Camera blocked — allow it, or use 📁 Photo / manual entry.</span>';
    });
}
function stopCam() {
  if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
  if (roiTimer) { clearInterval(roiTimer); roiTimer = null; }
}
function checkROI() {
  var v = $('cam'); if (!v.videoWidth) return;
  var s = analyzeFrame(v, 240, 320);
  var g = gateReasons(s);
  var roi = $('roi'), lab = $('roiLabel'), sh = $('shutter');
  roi.className = 'roi ' + (g.ok ? 'ok' : 'bad');
  lab.textContent = g.ok ? (R().colourWord.charAt(0).toUpperCase() + R().colourWord.slice(1)) + ' detected — tap the shutter' : g.shortMsg;
  // aria-disabled, never the disabled property: this runs on a 400ms interval, and
  // disabling a FOCUSED element blurs it, so a keyboard or switch user could be thrown
  // to the top of the document mid-capture. captureTest is deliberately not gated on it
  // either (it explains the specific problem instead), so the property bought nothing.
  sh.setAttribute('aria-disabled', g.ok ? 'false' : 'true');
  sh.classList.toggle('off', !g.ok);
  sh.setAttribute('aria-label', g.ok ? 'Capture test photo' : 'Capture test photo. ' + g.shortMsg);
}
// One gate used by BOTH the live preview and the photo-upload path, so an uploaded
// photo can never bypass a check the live path applies.
function gateReasons(s) {
  var rg = R();
  var t = timingGate();
  if (t) return { ok: false, shortMsg: t.shortMsg, longMsg: t.longMsg };
  if (s.overFrac > 0.15) return { ok: false, shortMsg: 'Too bright / glare — move to shade',
    longMsg: '<b>Too much glare.</b> Retake away from direct sun and reflections.' };
  // Reference problems are diagnosed BEFORE "no vial": without a usable white card the
  // segmentation has no basis at all, so "no vial detected" would name a symptom and
  // send the user to fix the wrong thing.
  if (s.clippedRef) return { ok: false, shortMsg: 'White card is blown out — reduce exposure',
    longMsg: '<b>White reference is clipped.</b> The card has saturated at the top of the sensor range, so its true brightness is unknown and every ratio against it would read LOW — the reassuring direction. Move out of direct sun or tap the card to re-expose, then retake.' };
  if (s.ref < 150) return { ok: false, shortMsg: 'Use a white background behind the vial',
    longMsg: '<b>No white reference.</b> Place the vial against plain white paper in even light and retake — a reading without a measured white reference is unreliable.' };
  if (!s.detected) {
    if (s.wrongReagent) return { ok: false, shortMsg: 'That vial looks ' + s.otherColour + ' — ' + s.otherName + ' is selected?',
      longMsg: '<b>Reagent mismatch.</b> ' + rg.name + ' is selected but the vial is <b>' + s.otherColour + '</b>, which is the ' + s.otherName + ' colour. Switch the reagent above, or re-run the test with ' + rg.name + '.' };
    return { ok: false, shortMsg: 'Align the ' + rg.colourWord + ' vial in the outline',
      longMsg: '<b>No ' + rg.colourWord + ' vial detected.</b> Align the ' + rg.name + ' vial against a white background and capture again. If the sample is truly colourless, confirm zero on the comparator card — this app will not report a zero it cannot see.' };
  }
  if (s.offChannel && s.offChannel.suspect) return { ok: false,
    shortMsg: 'Colour is not a clean yellow — check the reagent',
    longMsg: '<b>Off the yellow scale.</b> The vial is absorbing red light as well as blue, so it is not the clean yellow this calibration covers. If it looks <b>orange or brown</b> that is the top of the PHED card — <b>10 mg/L or more</b> of chlorine, far above what a photo can resolve: dilute 1:1 with chlorine-free water, set the dilution below, and photograph again. If it looks <b>blue-green</b> instead, the reagent is under-acidified or stale, or it is the neutral (IS 3025 Part 26) variant this app cannot read — make a fresh test with acid OTO.' };
  return { ok: true };
}

// Camera-shutter click, synthesized so the app stays asset-free and works offline.
// NOTE: audio is a bonus, never the only feedback. iOS mutes Web Audio outright when the
// hardware silent switch is on — a native camera bypasses that with a system shutter
// sound, a web app cannot — so shotFeedback() always flashes the frame as well.
var audioCtx = null;
function playShutterClick() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    // resume() is async. Scheduling against a still-suspended context is what makes the
    // FIRST tap silent while every later one works, so wait for it before scheduling.
    if (audioCtx.state === 'suspended') { audioCtx.resume().then(emitClick, function () {}); return; }
    emitClick();
  } catch (e) { }   // audio is cosmetic — never let it block a reading
}
function emitClick() {
  try {
    var t0 = audioCtx.currentTime, sr = audioCtx.sampleRate;
    [[0, 3800, 0.9], [0.055, 2600, 0.5]].forEach(function (p) {
      var len = Math.floor(sr * 0.03), buf = audioCtx.createBuffer(1, len, sr), d = buf.getChannelData(0);
      for (var n = 0; n < len; n++) d[n] = (Math.random() * 2 - 1) * Math.pow(1 - n / len, 8);
      var src = audioCtx.createBufferSource(); src.buffer = buf;
      var bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p[1]; bp.Q.value = 1.2;
      var g = audioCtx.createGain(); g.gain.value = p[2];
      src.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      src.start(t0 + p[0]);
    });
  } catch (e) { }   // audio is cosmetic — never let it block a reading
}

// Fires from the shutter button AND from a tap on the viewfinder.
var _lastShot = 0;
function captureTest() {
  // Rate limit. The viewfinder is a tap-anywhere target and a frustrated user on a
  // refusing frame can exceed 3 taps/second, which is a photosensitivity threshold for
  // a flash this large — and it also re-ran a full-resolution analysis per tap.
  var now = Date.now();
  if (now - _lastShot < 400) return;
  _lastShot = now;
  var v = $('cam');
  // The viewfinder tap bypasses the shutter's disabled state, so the no-camera case has
  // to be handled here: drawing a video with no frames yields a blank canvas, which
  // would be analysed as a real photograph.
  if (!camStream || !v.videoWidth) {
    clearResult('<b>Camera not running.</b> Allow camera access and tap ↻ Restart camera, or use 📁 Photo to pick an image, or enter the comparator-card reading below.');
    capRefused('The camera is not running');
    return;
  }
  shotFeedback();
  var w = v.videoWidth, h = v.videoHeight;
  // Deliberately NOT gated on the shutter's disabled state: if the frame is unusable the
  // user gets the specific reason from finishTest, which beats a tap that does nothing.
  finishTest(analyzeFrame(v, w, h), v, w, h);
}
function shotFeedback() {
  playShutterClick();
  var f = $('camFlash');
  if (f) { f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }  // restart the animation
  // 35ms, not 18: navigator.vibrate drives the legacy full-amplitude path, and much of
  // a very short request is spent spinning the motor up. Through a work glove at arm's
  // length, 18ms often is not felt at all.
  buzz(35);
}
// Each call REPLACES the pattern in progress, so an outcome buzz must be scheduled
// after the capture tick rather than stacked onto it; under ~150ms apart the two fuse
// into one perceived event anyway.
function buzz(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { } } }

// ---------------------------------------------------------------------------
// Capture confirmation strip
// ---------------------------------------------------------------------------
// Announcements go through #capLive, a permanently present visually-hidden region,
// NOT the strip: toggling a live region out of display:none announces unreliably, and
// the result card's own live region was removed so the same event is not read twice.
function capSay(msg) {
  var el = $('capLive'); if (!el) return;
  // Clear first. Writing a string the node already holds produces no mutation, so two
  // identical refusals in a row would be silent and the user would think it was ignored.
  el.textContent = '';
  setTimeout(function () { el.textContent = msg; }, 100);
}
function capHide() { var el = $('capStrip'); if (el) el.hidden = true; }
function capThumb(src, w, h) {
  var c = $('capThumb'); if (!c || !src) return;
  var x = c.getContext('2d');
  var sw = Math.min(w, h * 0.75), sh = sw / 0.75;      // widest 3:4 centre crop, never squeezed
  x.clearRect(0, 0, c.width, c.height);
  try { x.drawImage(src, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, c.width, c.height); } catch (e) { }
}
function capShow(state, mark, title, valHTML, sayHTML, actHTML, announce) {
  var el = $('capStrip'); if (!el) return;
  $('capMark').textContent = mark;
  $('capTitle').textContent = title;
  $('capVal').innerHTML = valHTML || '';
  $('capVal').style.display = valHTML ? 'block' : 'none';
  $('capSay').innerHTML = sayHTML || '';
  var act = $('capAct');
  act.innerHTML = actHTML || '';
  act.style.display = actHTML ? 'block' : 'none';
  el.hidden = false;
  el.className = 'cap ' + state;
  el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');   // restart the entry
  $('camHint').style.display = 'none';
  if (announce) capSay(announce);
}
function capJump() {
  var card = $('resultCard'); if (!card) return;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches;
  var h = $('resultHeading');
  h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true });
  card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}
// Refusals are the common case, not an error. Name the frame, never the person, and
// separate the mechanical event from the analytical one.
function capRefused(shortMsg) {
  capShow('no', '—', 'No reading from this shot', '',
    esc(shortMsg) + '<br><b>The photo was taken. Nothing was measured.</b>',
    '', 'No reading from this shot. ' + shortMsg + '. The photo was taken, nothing was measured. Take it again.');
  setTimeout(function () { buzz([60, 90, 60]); }, 180);
}
function capResult(r, rg, u, c) {
  var over = r.overRange;
  // SAFETY: an OTO success must not put a bare number above the fold. The full result
  // card wraps every OTO figure in a provisional range and the total-vs-free caveat;
  // repeating the number up here without them would quietly defeat that.
  var isOto = rg.species === 'total';
  var val = over
    ? '<span style="font-weight:600">&gt;</span>' + fmt(r.conc, 2) + ' <small>mg/L</small>'
    : (isOto ? fmt(r.concLo != null ? r.concLo : r.conc, 2) + '–' + fmt(r.concHi != null ? r.concHi : r.conc, 2) +
               ' <small>mg/L</small>'
             : fmt(r.conc, 2) + ' <small>mg/L</small>');
  var say = over
    ? 'The colour has saturated, so the true value is higher than this. Dilute 1:1, set <b>Dilution</b> in step 3, and photograph again.'
    : (isOto ? '<b>Total</b> chlorine · OTO' + (r.cardBand ? ' · PHED card: <b>' + esc(r.cardBand) + '</b>' : '') +
               '. This does <b>not</b> confirm free chlorine — see the full result.'
             : esc(rg.speciesLabel) + ' · ' + esc(rg.name) + '. Full result and guidance are in the card below.');
  var spoken = over
    ? 'Over range. More than ' + fmt(r.conc, 2) + ' milligrams per litre. The true value is higher. Dilute the sample and test again.'
    : (isOto ? 'Reading taken. Total chlorine, between ' + fmt(r.concLo, 2) + ' and ' + fmt(r.concHi, 2) +
               ' milligrams per litre. This does not confirm free chlorine.'
             : 'Reading taken. ' + fmt(r.conc, 2) + ' milligrams per litre ' + rg.speciesLabel.toLowerCase() + '. ' + c.label + '.');
  capShow(over ? 'over' : 'ok', over ? '▲' : '✓',
    over ? 'Above what this test can measure' : 'Photo read',
    val, say, 'See the full result <span class="cap-arw">▾</span>', spoken);
}
function loadPhoto(ev) {
  var f = ev.target.files[0]; if (!f) return;
  var img = new Image();
  img.onload = function () { finishTest(analyzeFrame(img, img.width, img.height), img, img.width, img.height); };
  img.onerror = function () { clearResult('That file could not be read as an image. Try another photo.'); };
  img.src = URL.createObjectURL(f);
}

// Clear the result area AND the previous reading's save row — a rejected shot must
// not leave a stale reading one tap away from the log.
function clearResult(noteHtml) {
  lastReading = null; lastResult = null; lastCapture = null;
  capHide();
  $('clResult').innerHTML = '— <small style="font-size:18px;font-weight:400">mg/L</small>';
  $('clBand').style.display = 'none'; $('gaugePin').style.display = 'none';
  $('clSteps').innerHTML = ''; $('recordBlock').style.display = 'none';
  $('readingSummary').style.display = 'none'; $('saveBtn').style.display = 'none';
  $('otoCaution').style.display = 'none'; $('pdfNote').textContent = '';
  $('saveHint').style.display = 'block';
  $('clNote').innerHTML = noteHtml;
}
function finishTest(s, srcEl, w, h) {
  var g = gateReasons(s);
  // Thumbnail BEFORE the gate, and synchronously: on a refusal the picture is the
  // explanation — the user sees the glare or the missing white paper and understands
  // without reading. It must be read now because for a camera capture srcEl is the live
  // <video>, and a deferred read would grab a different frame.
  capThumb(srcEl, w, h);
  if (!g.ok) { clearResult(g.longMsg); capRefused(g.shortMsg); return; }
  // Freeze the captured frame into an offscreen canvas.
  //
  // Sample details are filled in AFTER the shot, so editing them has to re-stamp the
  // photo or the image would carry a different site name from the record beside it. The
  // stamp cannot be redrawn from the original source element: for a camera capture that
  // is the live <video>, and re-reading it would silently stamp a LATER frame — a
  // different photograph — onto the same reading.
  var frame = document.createElement('canvas');
  frame.width = w; frame.height = h;
  frame.getContext('2d').drawImage(srcEl, 0, 0, w, h);
  lastCapture = { frame: frame, w: w, h: h };

  var r = concFromChannel(s.sample, s.ref, dilutionFactor());
  criticalShown = false;
  renderResult(r, { s: s.sample, ref: s.ref });
  stampImage(frame, w, h, r);
  // Suppressed when the reading is critical: #critical takes focus immediately and
  // would preempt the announcement. ackCritical shows the strip once dismissed.
  if (!criticalShown) capResult(lastReading, R(), U(), classify(r.conc, R(), U(), r.overRange));
}
function manualResult() {
  var v = parseFloat($('manualCl').value);
  if (!(v >= 0)) { $('clNote').textContent = 'Enter the card reading in mg/L.'; return; }
  criticalShown = false;
  renderResult({ conc: v, manual: true, adviseDil: false, overRange: false, extrapolated: false }, null);
  $('recordBlock').style.display = 'none';
  capHide();   // a typed comparator reading is not a photo; the strip must not claim one
}
function rerender() {
  if (!lastResult) return;
  // Dilution changes the number itself, so recompute from the stored channel
  // medians rather than rescaling an already-rounded result.
  var r = lastResult.px && !lastResult.r.manual
    ? concFromChannel(lastResult.px.s, lastResult.px.ref, dilutionFactor())
    : lastResult.r;
  renderResult(r, lastResult.px);
  if (lastCapture) stampImage(lastCapture.frame, lastCapture.w, lastCapture.h, r);
}

function renderResult(r, px) {
  lastResult = { r: r, px: px };
  var rg = R(), u = U(), c = classify(r.conc, rg, u, r.overRange);

  // The OTO constant carries +/-40% in BOTH directions, and that interval straddles the
  // 0.2 mg/L adequacy threshold. Publishing a bare "0.21 mg/L" would imply a precision
  // the method does not have, right where the number decides whether water is treated
  // as disinfected — so OTO numbers are shown as an interval.
  var iv = (rg.species === 'total' && !r.manual && !r.overRange && r.T != null)
    ? concInterval(r.T, rg, dilutionFactor()) : null;
  var band = iv
    ? '<div style="font-size:13px;font-weight:600;color:var(--amber);margin-top:2px">provisional range ' +
      fmt(iv.lo, 2) + '–' + fmt(iv.hi, 2) + (iv.open ? '+' : '') + ' mg/L</div>' : '';
  $('clResult').innerHTML = (r.overRange ? '&gt;' : '') + fmt(r.conc, 2) +
    ' <small style="font-size:18px;font-weight:400">mg/L</small>' +
    '<div style="font-size:13px;font-weight:600;color:var(--grey);margin-top:2px">' +
    rg.speciesLabel + ' · ' + rg.name + '</div>' + band;
  var b = $('clBand'); b.style.display = 'inline-block'; b.className = 'band ' + c.band; b.textContent = c.label;
  var pin = $('gaugePin'); pin.style.display = 'block';
  pin.style.left = Math.max(0, Math.min(100, (r.conc / u.gaugeMax) * 100)) + '%';

  var st = [];
  if (!r.manual && px) {
    st.push(rg.channelName.charAt(0).toUpperCase() + rg.channelName.slice(1) +
      ' read from photo: <span class="u">vial ' + rg.channelName.charAt(0).toUpperCase() + '=' + fmt(px.s, 1) +
      ' · white ' + rg.channelName.charAt(0).toUpperCase() + '=' + fmt(px.ref, 1) + '</span>');
    st.push('Absorbance A = log₁₀(white/vial) = <span class="u">' + fmt(r.A, 4) + '</span>');
    var dil = dilutionFactor();
    st.push(rg.leak
      ? 'Leak-corrected: ' + rg.speciesLabel + ' = ' + rg.k + '×(1−' + rg.leak + ') × log₁₀((1−' + rg.leak +
        ')/(T−' + rg.leak + ')), T=' + fmt(r.T, 3) + (dil > 1 ? ' × ' + dil : '') +
        ' = <span class="u"><b>' + (r.overRange ? '&gt;' : '') + fmt(r.conc, 2) + ' mg/L</b></span>'
      : rg.speciesLabel + ' = ' + rg.k + ' × A' + (dil > 1 ? ' × ' + dil + ' (dilution)' : '') +
        ' = <span class="u"><b>' + (r.overRange ? '&gt;' : '') + fmt(r.conc, 2) + ' mg/L</b></span>');
  } else if (r.manual) {
    st.push('Manual comparator-card reading: <b>' + fmt(r.conc, 2) + ' mg/L</b> (' + rg.speciesLabel.toLowerCase() + ')');
  }
  $('clSteps').innerHTML = st.map(function (x) { return '<li>' + x + '</li>'; }).join('');

  var cyaRaw = ($('cya') && useId === 'pool') ? $('cya').value : '';
  var cya = (cyaRaw !== '' && isFinite(parseFloat(cyaRaw))) ? parseFloat(cyaRaw) : null;

  var note;
  if (rg.species === 'total') {
    var cardBand = otoCardBand(r.conc);
    note = c.band === 'zero'
      ? 'No chlorine of any kind — see the alert.'
      : 'Total chlorine is ' + (r.overRange ? 'over ' : '') + fmt(r.conc, 2) + ' mg/L. Free (disinfecting) chlorine is somewhere between 0 and this value.' +
        (cardBand ? ' On the PHED OTO card this is the ' + cardBand + ' — check it against the card in your hand.' : '');
    if (c.band === 'high') note += ' This exceeds the ' + u.max + ' mg/L guideline for ' + u.label.toLowerCase() + ' — reduce dosing.';
  } else {
    note = { zero: 'No disinfection — see the alert.',
      low: 'Below ' + (u.id === 'pool' && cya > 0 ? '2 mg/L (MAHC stabilized minimum)' : u.min + ' mg/L') + '. Increase chlorination and re-test.',
      ok: 'Within the ' + u.label.toLowerCase() + ' range (' + (u.id === 'pool' && cya > 0 ? '2–3 mg/L with stabilizer' : u.min + '–' + u.idealHigh + ' mg/L') + ').',
      high: 'Above ' + u.idealHigh + ' mg/L — reduce dosing; high chlorine causes taste/odour complaints and irritation.',
      vhigh: 'Well above the guideline — do not use until it falls.' }[c.band];
  }
  if (r.overRange) note += ' The ' + rg.channelName + ' channel is saturated, so this is a LOWER BOUND, not a measurement — dilute and re-test with the dilution set.';
  else if (r.extrapolated) note += ' Above the calibrated range (' + rg.fitMax + ' mg/L undiluted), so the value is extrapolated — dilute and re-test to confirm.';
  else if (r.adviseDil) note += ' Dilute 1:1 with chlorine-free water, set the dilution, and re-test for accuracy.';
  if (cya !== null && cya > 90) note += ' CYA ' + cya + ' mg/L exceeds the MAHC maximum (90) — replace ' + Math.round((1 - 90 / cya) * 100) + '% of the water to dilute the stabilizer.';
  $('clNote').textContent = note;

  // The total-vs-free caveat gets its own persistent block, not a footnote.
  var cau = $('otoCaution');
  if (rg.species === 'total' && c.band !== 'zero') {
    cau.style.display = 'block';
    cau.innerHTML = '<b>This is not a free-chlorine result.</b> OTO responds to free chlorine <i>and</i> to chloramines, so ' +
      fmt(r.conc, 2) + ' mg/L is the <b>upper bound</b> on free chlorine — the true free residual may be anywhere from 0 to ' +
      fmt(r.conc, 2) + ' mg/L. The ' + esc(u.label.toLowerCase()) + ' standard (' +
      (u.id === 'pool' ? '1–3' : '≥0.2') + ' mg/L) is written against <b>free</b> chlorine and <b>cannot be shown to be met from this test</b>. ' +
      'Re-test with DPD No.1 to confirm the free residual.' +
      (lastReading && lastReading.reactionS === null
        ? '<br><br><b>Reaction time not recorded.</b> Read at a few seconds this is nearer free chlorine; at five minutes it is total. Without the timer the reading sits somewhere between the two.'
        : '') +
      '<br><br>The OTO constant is <b>provisional (±40%)</b> and OTO reads low against reference methods — about 90% of true for inorganic chloramines and as little as 50% in real pool water. ' +
      'Near the ' + (u.id === 'pool' ? '1 mg/L' : '0.2 mg/L') + ' line this test cannot tell adequate from inadequate residual.' +
      // The single most dangerous real pool is one where all the chlorine is combined:
      // it smells strongly of chlorine, has no sanitiser at all, and is exactly the
      // state OTO is blind to. Name it, in pool mode, rather than leave it implied.
      (u.id === 'pool'
        ? '<br><br><b>Pool-specific warning.</b> The classic outbreak pool reads high on total chlorine and <b>zero on free</b> — all of it bound up as chloramine. It smells strongly of chlorine and is not disinfected at all. OTO cannot distinguish that pool from a properly sanitized one. <b>Do not reopen or clear a pool on an OTO reading</b>; use DPD No.1.'
        : '');
  } else { cau.style.display = 'none'; }

  // Active HOCl only means something for FREE chlorine; computing it from an OTO
  // total would dress up an upper bound as a disinfection figure.
  var temp = $('temp').value, ph = $('ph').value;
  var tempN = (temp !== '' ? parseFloat(temp) : null), phN = (ph !== '' ? parseFloat(ph) : null);
  var hoclF = null, activeCl = null, hoclHTML = '';
  if (rg.species === 'free' && phN !== null && isFinite(phN)) {
    var T = (isFinite(tempN) ? tempN : 25) + 273.15;
    var pKa = 3000.0 / T - 10.0686 + 0.0253 * T;       // Morris (1966)
    var f = 1 / (1 + Math.pow(10, phN - pKa));
    hoclF = f; activeCl = f * r.conc;
    var badge;
    if (f < 0.20) badge = '<span class="phb warn" style="background:#ffd2d2;color:#a10000">disinfection largely ineffective at this pH even though the residual reads adequate — correct pH first</span>';
    else if (phN > 7.8) badge = '<span class="phb warn">raise efficacy — lower pH toward 7.2–7.8</span>';
    else if (f >= 0.45) badge = '<span class="phb ok">good HOCl fraction</span>';
    else badge = '<span class="phb ok">acceptable — pH at the high end of 7.2–7.8</span>';
    hoclHTML = '<br>Active HOCl: ' + Math.round(f * 100) + '% → effective chlorine ' + fmt(activeCl, 2) + ' mg/L ' + badge;
  } else if (rg.species === 'total' && phN !== null && isFinite(phN)) {
    hoclHTML = '<br><span style="color:#8a4b00">Active-HOCl fraction is not computed for OTO — it applies to the free residual, which this test does not resolve.</span>';
  }

  lastReading = {
    reagent: rg.name, species: rg.species, speciesLabel: rg.speciesLabel, use: u.label,
    conc: r.conc, overRange: !!r.overRange, extrapolated: !!r.extrapolated,
    concLo: iv ? parseFloat(iv.lo.toFixed(2)) : null,
    concHi: iv ? parseFloat(iv.hi.toFixed(2)) : null,
    concOpen: iv ? !!iv.open : false,
    transmittance: (r.T != null && isFinite(r.T)) ? parseFloat(r.T.toFixed(4)) : null,
    band: c.band, bandLabel: c.label, manual: !!r.manual,
    dilution: dilutionFactor(), absorbance: (r.A != null && isFinite(r.A)) ? parseFloat(r.A.toFixed(4)) : null,
    chSample: px ? px.s : null, chWhite: px ? px.ref : null,
    temp: tempN, ph: phN, cya: cya,
    hoclFraction: (hoclF !== null ? parseFloat(hoclF.toFixed(3)) : null),
    activeCl: (activeCl !== null ? parseFloat(activeCl.toFixed(2)) : null),
    reactionS: (rg.species === 'total' && !r.manual) ? (elapsedS() === null ? null : Math.round(elapsedS())) : undefined,
    cardBand: rg.species === 'total' ? otoCardBand(r.conc) : null,
    site: ($('siteName').value || '').trim(),
    lat: lastGeo ? lastGeo.lat : null, lon: lastGeo ? lastGeo.lon : null,
    ts: new Date().toISOString()
  };

  var sum = $('readingSummary'); sum.style.display = 'block';
  sum.innerHTML = '<b>Reading</b> — ' + esc(rg.speciesLabel) + ' <b>' + (r.overRange ? '&gt;' : '') + fmt(r.conc, 2) + ' mg/L</b>' +
    '  ·  ' + esc(rg.name) + '  ·  ' + esc(u.label) +
    '  ·  Temp ' + (tempN !== null ? fmt(tempN, 1) + ' °C' : '—') +
    '  ·  pH ' + (phN !== null ? fmt(phN, 2) : '—') +
    (cya !== null ? '  ·  CYA ' + fmt(cya, 0) + ' mg/L' : '') + hoclHTML;

  $('saveBtn').style.display = 'block';
  $('saveHint').style.display = 'none';
  // Once per CAPTURE, not once per render. rerender() runs on every keystroke in the
  // sample-detail fields, and without this the alert re-opened and stole focus out of
  // the text box on every character typed after a zero reading.
  if (c.critical && !criticalShown) { criticalShown = true; triggerCritical(); }
}

// ---- pH advisory ----
function checkPH() {
  var el = $('phBadge'), v = parseFloat($('ph').value);
  if (!isFinite(v)) { el.innerHTML = ''; return; }
  if (v >= 7.2 && v <= 7.8) el.innerHTML = '<span class="phb ok">ideal (7.2–7.8)</span>';
  else if (v >= 6.5 && v <= 8.5) el.innerHTML = '<span class="phb warn">acceptable — aim 7.2–7.8</span>';
  else el.innerHTML = '<span class="phb warn">out of range — correct pH</span>';
  rerender();
}

// ---- day-wise on-device test log ----
var LOGKEY = 'aquasafe_log_v1';
function loadLog() { try { return JSON.parse(localStorage.getItem(LOGKEY) || '[]'); } catch (e) { return []; } }
var _capWarned = false;
function saveLog(a) {
  if (a.length > 2000) {
    a.splice(0, a.length - 2000);
    if (!_capWarned) { _capWarned = true; console.warn('Aquasafe: log capped at 2000 records — oldest tests were dropped. Export the CSV to keep them.'); }
  }
  try { localStorage.setItem(LOGKEY, JSON.stringify(a)); return true; }
  catch (e) { alert('Could not save — device storage is full. Export the CSV, then clear old tests.'); return false; }
}
function saveReading() {
  if (!lastReading) return;
  var log = loadLog(); log.push(lastReading);
  if (saveLog(log)) {
    $('saveBtn').textContent = '✓ Saved to log';
    setTimeout(function () { $('saveBtn').textContent = '＋ Save this test to the log'; }, 1500);
  }
  renderHistory();
}
function renderHistory() {
  var log = loadLog();
  var empty = $('histEmpty'), body = $('histBody'), act = $('histActions');
  if (!log.length) { empty.style.display = 'block'; body.style.display = 'none'; act.style.display = 'none'; return; }
  empty.style.display = 'none'; body.style.display = 'block'; act.style.display = 'flex';
  var byDay = {};
  log.forEach(function (r) {
    var d = new Date(r.ts);
    var key = isFinite(d) ? d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)
      : String(r.ts || '').slice(0, 10);
    (byDay[key] = byDay[key] || []).push(r);
  });
  var days = Object.keys(byDay).sort().reverse();
  var h = '<table class="htable"><tr><th>Time</th><th>Sample point</th><th>Reagent</th><th>mg/L</th><th>Species</th><th>Verdict</th></tr>';
  days.forEach(function (day) {
    var rows = byDay[day].sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    // Free and total are different quantities — averaging them together would be
    // meaningless, so the day header summarises each species separately.
    var parts = ['free', 'total'].map(function (sp) {
      var g = rows.filter(function (r) { return (r.species || 'free') === sp; });
      if (!g.length) return null;
      return g.length + ' ' + sp + ', mean ' + fmt(g.reduce(function (s, r) { return s + r.conc; }, 0) / g.length, 2) + ' mg/L';
    }).filter(Boolean);
    var disp = new Date(day + 'T00:00:00').toLocaleDateString(APP_LOCALE, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    h += '<tr><td class="daygrp" colspan="6">' + disp + '  —  ' + parts.join('  ·  ') + '</td></tr>';
    rows.forEach(function (r) {
      var t = new Date(r.ts).toLocaleTimeString(APP_LOCALE, { hour: '2-digit', minute: '2-digit' });
      h += '<tr><td>' + t + '</td><td class="l">' + esc(r.site || '—') + '</td><td>' + esc(r.reagent || 'DPD') + '</td><td><b>' +
        (r.overRange ? '&gt;' : '') + fmt(r.conc, 2) + '</b></td><td class="l">' + esc(r.speciesLabel || 'Free chlorine') +
        '</td><td class="l">' + esc(r.bandLabel || '') + '</td></tr>';
    });
  });
  h += '</table>';
  body.innerHTML = h;
}
// RFC 4180 quoting + spreadsheet formula-injection neutralization
function csvCell(v) {
  var s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s.trim())) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function exportHistory() {
  var log = loadLog(); if (!log.length) return;
  var head = ['timestamp', 'date', 'time', 'sample_point', 'reagent', 'species', 'chlorine_mg_L',
    'over_range', 'range_lo_mg_L', 'range_hi_mg_L', 'phed_card_band', 'verdict', 'use', 'dilution', 'reaction_time_s', 'absorbance', 'channel_sample', 'channel_white',
    'temperature_C', 'pH', 'cyanuric_acid_mg_L', 'hocl_fraction', 'active_chlorine_mg_L',
    'latitude', 'longitude', 'source'];
  var lines = [head.map(csvCell).join(',')];
  log.forEach(function (r) {
    var d = new Date(r.ts);
    lines.push([r.ts, d.toLocaleDateString(APP_LOCALE), d.toLocaleTimeString(APP_LOCALE), r.site || '',
      r.reagent || 'DPD', r.speciesLabel || 'Free chlorine', fmt(r.conc, 2), r.overRange ? 'yes' : 'no',
      r.concLo != null ? r.concLo : '', r.concHi != null ? r.concHi : '', r.cardBand || '',
      r.bandLabel || '', r.use || '', r.dilution != null ? r.dilution : '',
      r.reactionS != null ? r.reactionS : (r.species === 'total' ? 'not recorded' : ''),
      r.absorbance != null ? r.absorbance : '', r.chSample != null ? fmt(r.chSample, 1) : '',
      r.chWhite != null ? fmt(r.chWhite, 1) : '', r.temp != null ? r.temp : '', r.ph != null ? r.ph : '',
      r.cya != null ? r.cya : '', r.hoclFraction != null ? r.hoclFraction : '',
      r.activeCl != null ? r.activeCl : '', r.lat != null ? r.lat : '', r.lon != null ? r.lon : '',
      r.manual ? 'manual card' : 'photo'].map(csvCell).join(','));
  });
  // UTF-8 BOM so Excel decodes non-ASCII sample-point names; CRLF per RFC 4180
  var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, 'aquasafe_log_' + new Date().toISOString().slice(0, 10) + '.csv');
}
function clearHistory() {
  if (confirm('Clear all saved tests on this device? Export first if you need them.')) { saveLog([]); renderHistory(); }
}
function downloadBlob(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

// ---- tamper-evident overlay ----
// Draw `s` at `size`, shrinking (to a floor) until it fits `maxW`. Returns nothing;
// the point is that stamped text is never silently clipped by the frame width.
function fitText(cx, s, x, y, maxW, size, bold) {
  var px = size;
  cx.font = (bold ? 'bold ' : '') + px + 'px sans-serif';
  while (px > 8 && cx.measureText(s).width > maxW) {
    px -= 1;
    cx.font = (bold ? 'bold ' : '') + px + 'px sans-serif';
  }
  cx.fillText(s, x, y);
}
function stampImage(srcEl, w, h, r) {
  var rg = R();
  var maxW = 900, sc = Math.min(1, maxW / w), cw = Math.round(w * sc), ch = Math.round(h * sc);
  var site = ($('siteName').value || '').trim();
  var tv = $('temp').value, pv = $('ph').value;
  var hasTP = (tv !== '' || pv !== '');
  var band = Math.round(cw * (0.44 + (site ? 0.06 : 0) + (hasTP ? 0.06 : 0)));
  var cv = $('stampCanvas'); cv.width = cw; cv.height = ch + band;
  var cx = cv.getContext('2d'); cx.drawImage(srcEl, 0, 0, cw, ch);
  cx.fillStyle = 'rgba(4,40,48,.92)'; cx.fillRect(0, ch, cw, band);
  var now = new Date();
  var ts = now.toLocaleString(APP_LOCALE, { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  var off = -now.getTimezoneOffset() / 60, tz = 'GMT' + (off >= 0 ? '+' : '') + off;
  var pad = Math.round(cw * 0.03), y = ch + pad * 1.2, lh = Math.round(band * 0.10);
  cx.textBaseline = 'top';
  cx.fillStyle = '#8fe3f0'; cx.font = 'bold ' + Math.round(band * 0.13) + 'px sans-serif';
  fitText(cx, rg.speciesLabel + ' = ' + (r.overRange ? '>' : '') + r.conc.toFixed(2) + ' mg/L', pad, y, cw - 2 * pad, Math.round(band * 0.13), true); y += lh * 1.45;
  cx.fillStyle = '#ffd98a';
  // This line is the one that must never be truncated — a stamped photo reading
  // "NOT a free-chlori" is worse than useless as a record. Shrink to fit the frame
  // rather than trusting a fixed size against an unknown capture width.
  fitText(cx, rg.name + ' reagent · ' + U().label + (rg.species === 'total' ? ' · NOT a free-chlorine result' : ''),
    pad, y, cw - 2 * pad, Math.round(band * 0.075), true); y += lh;
  cx.fillStyle = '#fff'; cx.font = Math.round(band * 0.075) + 'px sans-serif';
  if (site) { fitText(cx, 'Site: ' + site.substring(0, 46), pad, y, cw - 2 * pad, Math.round(band * 0.085), true); y += lh; cx.font = Math.round(band * 0.075) + 'px sans-serif'; }
  if (hasTP) { cx.fillText('Temp ' + (tv !== '' ? parseFloat(tv).toFixed(1) + ' °C' : '—') + '    pH ' + (pv !== '' ? parseFloat(pv).toFixed(2) : '—'), pad, y); y += lh; }
  var lat = lastGeo ? lastGeo.lat.toFixed(5) : '—', lon = lastGeo ? lastGeo.lon.toFixed(5) : '—';
  cx.fillText('Lat ' + lat + '   Long ' + lon + (lastGeo ? '' : '  (location unavailable)'), pad, y); y += lh;
  cx.fillText(ts + '  ' + tz, pad, y); y += lh;
  cx.fillStyle = '#7fb8c4'; cx.fillText('Address & map: when online…', pad, y);
  drawMapSnippet(cx, cw, ch, band, pad, y, lat, lon);
  $('recordBlock').style.display = 'block';
  $('dlStamp').href = cv.toDataURL('image/png');
  $('dlStamp').download = 'aquasafe-' + rg.id + '-' + now.toISOString().slice(0, 10) + '.png';
}
// Keep the stamp English-only: Nominatim returns local-script names for places with
// no name:en tag, so drop any comma-part that is not Latin script.
function englishOnlyAddress(s) {
  var nonLatin = /[^ -ɏ‐-‧‰-⁞]/;
  return String(s).split(',').map(function (p) { return p.trim(); })
    .filter(function (p) { return p && !nonLatin.test(p); }).join(', ');
}
var lastAddress = '';
function drawMapSnippet(cx, cw, ch, band, pad, addrY, lat, lon) {
  if (!lastGeo) return;
  fetch('https://nominatim.openstreetmap.org/reverse?format=json&accept-language=en&lat=' + lastGeo.lat + '&lon=' + lastGeo.lon)
    .then(function (x) { return x.json(); }).then(function (j) {
      var addr = j && j.display_name ? englishOnlyAddress(j.display_name) : '';
      if (addr) {
        lastAddress = addr;
        if (lastReading) lastReading.address = addr;
        cx.fillStyle = 'rgba(4,40,48,.92)'; cx.fillRect(pad, addrY, cw - 2 * pad, band * 0.12);
        cx.fillStyle = '#bfe8ef'; cx.font = Math.round(band * 0.068) + 'px sans-serif';
        cx.fillText(addr.substring(0, 64), pad, addrY);
        $('dlStamp').href = $('stampCanvas').toDataURL('image/png');
      }
    }).catch(function () { });
  var msz = Math.round(band * 0.66), mx = cw - msz - pad, my = ch + (band - msz) / 2;
  var img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = function () {
    cx.drawImage(img, mx, my, msz, msz); cx.strokeStyle = '#8fe3f0'; cx.strokeRect(mx, my, msz, msz);
    $('dlStamp').href = $('stampCanvas').toDataURL('image/png');
  };
  img.src = 'https://staticmap.openstreetmap.de/staticmap.php?center=' + lat + ',' + lon +
    '&zoom=16&size=' + msz + 'x' + msz + '&markers=' + lat + ',' + lon + ',red-pushpin';
}

// ---------------------------------------------------------------------------
// PDF report
// ---------------------------------------------------------------------------
function buildReportDoc() {
  if (!lastReading) return null;
  var r = lastReading, rg = REAGENTS[r.reagent === 'OTO' ? 'oto' : 'dpd'], u = U();
  var d = new Date(r.ts);
  var when = d.toLocaleString(APP_LOCALE, { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  var off = -d.getTimezoneOffset() / 60;

  var VERDICT_RGB = {
    ok: [[0.84, 0.96, 0.84], [0.08, 0.41, 0.11]],
    info: [[0.87, 0.91, 0.96], [0.07, 0.23, 0.39]],
    low: [[1, 0.90, 0.76], [0.54, 0.29, 0]],
    high: [[1, 0.88, 0.69], [0.54, 0.23, 0]],
    vhigh: [[1, 0.79, 0.79], [0.54, 0, 0]],
    zero: [[1, 0.82, 0.82], [0.63, 0, 0]]
  }[r.band] || [[0.9, 0.9, 0.9], [0.2, 0.2, 0.2]];

  var rows = [
    ['Sample point', r.site || 'not recorded'],
    ['Application', r.use],
    ['Reagent', rg.name + ' — measures ' + rg.speciesLabel.toLowerCase()],
    ['Date & time', when + '  (GMT' + (off >= 0 ? '+' : '') + off + ')'],
    ['Coordinates', (r.lat != null && r.lon != null) ? r.lat.toFixed(5) + ', ' + r.lon.toFixed(5) : 'location unavailable'],
  ];
  if (r.address) rows.push(['Address', r.address]);
  rows.push(['Method', r.manual ? 'Visual comparator card (manual entry)' : 'Smartphone photometry, ' + rg.channelName + ' channel']);

  var method = [];
  if (!r.manual && r.chSample != null) {
    method.push(['Vial ' + rg.channelName + ' (median)', fmt(r.chSample, 1)]);
    method.push(['White reference ' + rg.channelName, fmt(r.chWhite, 1)]);
    method.push(['Absorbance A = log10(white/vial)', fmt(r.absorbance, 4)]);
    method.push(['Calibration', rg.speciesLabel + ' = ' + rg.k + ' x A' + (r.dilution > 1 ? '  x ' + r.dilution + ' (dilution)' : '')]);
  }
  if (r.cardBand) method.push(['PHED OTO card', r.cardBand]);
  method.push(['Dilution', r.dilution > 1 ? '1:' + (r.dilution - 1) + ' with chlorine-free water (x' + r.dilution + ')' : 'undiluted']);
  if (r.species === 'total' && !r.manual) {
    method.push(['Reaction time', r.reactionS == null
      ? 'not recorded'
      : Math.floor(r.reactionS / 60) + ' min ' + (r.reactionS % 60) + ' s' +
        (r.reactionS <= 120 ? ' (read promptly, per PHED protocol)' : ' - DELAYED, reads high')]);
  }
  if (r.temp != null) method.push(['Water temperature', fmt(r.temp, 1) + ' °C']);
  if (r.ph != null) method.push(['pH', fmt(r.ph, 2)]);
  if (r.cya != null) method.push(['Cyanuric acid', fmt(r.cya, 0) + ' mg/L']);
  if (r.hoclFraction != null) {
    method.push(['Active HOCl fraction', Math.round(r.hoclFraction * 100) + '% (Morris 1966 pKa)']);
    method.push(['Effective chlorine', fmt(r.activeCl, 2) + ' mg/L as HOCl']);
  }

  var notes = [];
  if (r.species === 'total' && r.band !== 'zero') {
    notes.push({ heading: 'Interpretation — read this before acting',
      bold: true, rgb: [0.55, 0.27, 0],
      text: 'This is a TOTAL chlorine result, not a free-chlorine result. OTO responds to free chlorine and to ' +
        'chloramines together, so ' + fmt(r.conc, 2) + ' mg/L is an UPPER BOUND on the free residual: the true free ' +
        'chlorine may be anywhere from 0 to ' + fmt(r.conc, 2) + ' mg/L. The ' + r.use.toLowerCase() + ' standard is written ' +
        'against free chlorine, and compliance with it CANNOT be demonstrated from this test. Re-test with DPD No.1 ' +
        'to establish the free residual.' });
    notes.push({ text: 'Two further reasons not to read this as a compliance figure. First, the OTO constant used here is ' +
      'PROVISIONAL: no published molar absorptivity exists for the o-tolidine yellow product, so it was reasoned from the ' +
      'DPD calibration rather than fitted, and carries about +/- 40%. Second, orthotolidine reads LOW against reference ' +
      'methods even with perfect optics - roughly 90% of true for hypochlorite and inorganic chloramines, and as little ' +
      'as 50% for organic chloramines and real chlorinated pool water. Both errors point the same way as the total-vs-free ' +
      'problem: toward false reassurance.' });
    if (r.reactionS != null && r.reactionS > 120) {
      notes.push({ bold: true, rgb: [0.55, 0.27, 0],
        text: 'Read ' + Math.floor(r.reactionS / 60) + ' min ' + (r.reactionS % 60) + ' s after mixing. The PHED protocol ' +
          'requires the colour to be evaluated immediately, because it keeps rising and a delayed reading OVER-reports ' +
          'the residual. Treat this figure as an over-estimate.' });
    }
  } else if (r.species === 'total') {
    notes.push({ heading: 'Interpretation', bold: true, rgb: [0.63, 0, 0],
      text: 'Total chlorine is zero. Because total chlorine is the sum of free and combined chlorine, a total of zero ' +
        'does establish that free chlorine is also zero: there is no disinfectant residual of any kind in this sample.' });
  } else {
    notes.push({ heading: 'Interpretation',
      text: 'DPD No.1 measures free chlorine — the fraction that provides disinfection, and the quantity the standard ' +
        'is written against. Reading: ' + r.bandLabel + '.' });
  }
  if (r.overRange) {
    notes.push({ bold: true, rgb: [0.63, 0, 0],
      text: 'OVER RANGE: the ' + rg.channelName + ' channel was saturated, so ' + fmt(r.conc, 2) +
        ' mg/L is a lower bound, not a measurement. Dilute the sample and re-test with the dilution factor set.' });
  } else if (r.extrapolated) {
    notes.push({ text: 'Above the calibrated range (' + rg.fitMax + ' mg/L undiluted); the value is extrapolated from the ' +
      'calibration line and should be confirmed by dilution or by a bench photometer.' });
  }
  notes.push({ heading: 'Standard applied', text: u.standard });
  notes.push({ text: 'Aquasafe is a screening aid, not a certified laboratory analysis. Colorimetry from a consumer ' +
    'camera is sensitive to lighting, white balance and turbidity. Confirm any result that drives a public-health ' +
    'decision against a comparator card or a bench photometer.' });

  var img = null;
  if (!r.manual) {
    try { img = $('stampCanvas').toDataURL('image/jpeg', 0.72); } catch (e) { img = null; }
  }

  return {
    appName: 'Aquasafe',
    title: 'Chlorine Field Test Report',
    reagent: rg.name,
    stamp: when,
    resultLabel: rg.speciesLabel.toUpperCase() + (r.manual ? ' (comparator card)' : ''),
    resultValue: (r.overRange ? '>' : '') + fmt(r.conc, 2) + ' mg/L',
    resultSub: r.concLo != null
      ? 'provisional range ' + fmt(r.concLo, 2) + ' - ' + fmt(r.concHi, 2) + ' mg/L (constant is +/- 40%)' : '',
    verdict: r.bandLabel,
    verdictRGB: VERDICT_RGB[0], verdictInk: VERDICT_RGB[1],
    sections: [{ heading: 'Sample', rows: rows }, { heading: 'Measurement', rows: method }],
    notes: notes,
    imageDataURL: img,
    footer: 'Generated by Aquasafe (' + (location.origin + location.pathname).replace(/index\.html$/, '') + ') on ' + when +
      '. Reagent ' + rg.name + ', ' + rg.speciesLabel.toLowerCase() + '. This document records a field screening test.'
  };
}
function downloadPDF() {
  var doc = buildReportDoc();
  if (!doc) { $('pdfNote').textContent = 'Capture a test first.'; return; }
  try {
    var blob = AquasafePDF.build(doc);
    var name = 'aquasafe-' + doc.reagent.toLowerCase() + '-report-' + new Date().toISOString().slice(0, 10) + '.pdf';
    downloadBlob(blob, name);
    $('pdfNote').textContent = 'PDF saved as ' + name + '.';
  } catch (e) {
    $('pdfNote').textContent = 'Could not build the PDF: ' + e.message;
    console.error('Aquasafe PDF build failed', e);
  }
}

// ---- critical zero protocol ----
function triggerCritical() {
  var u = U();
  $('criticalTitle').textContent = u.zeroTitle;
  $('criticalAdv').innerHTML = u.zeroAdv +
    (R().species === 'total' ? '<br><br>Measured with OTO (total chlorine). A total of zero does mean free chlorine is zero — there is no residual of any kind.' : '');
  $('critical').classList.add('show');
  $('ackBtn').focus();
}
function ackCritical() {
  $('critical').classList.remove('show');
  $('clNote').textContent = 'ZERO chlorine acknowledged at ' + new Date().toLocaleTimeString(APP_LOCALE) +
    '. Corrective action required — re-test after dosing.';
  // ackCritical scrolls the shutter back into view, so card 2 must carry the outcome.
  if (lastReading) {
    capShow('no', '!', 'ZERO chlorine — no disinfection', '0.00 <small>mg/L</small>',
      'Acknowledged. Dose the supply and test again.',
      'See the full result <span class="cap-arw">▾</span>',
      'Zero chlorine. No disinfection. Dose the supply and test again.');
  }
  $('shutter').focus();
}

// ---- init ----
function init() {
  setReagent('dpd'); setUse('drinking');
  clearResult('Capture a test to see the result.');
  requestGeo(); startCam(); renderHistory();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
}
if (typeof document !== 'undefined' && document.getElementById('rgDpd')) init();

// Exposed for the test harness (Node + headless browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REAGENTS: REAGENTS, USES: USES, concFromChannel: concFromChannel, classify: classify };
}
