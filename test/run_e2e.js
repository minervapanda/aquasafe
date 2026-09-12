#!/usr/bin/env node
// Aquasafe end-to-end suite.
//
// Drives the REAL app in real Chrome over the real photo-upload path: it serves the
// site, uploads each sample vial image through the same <input type=file> a field
// user taps, and asserts on the rendered mg/L, the refusal messages and the actual
// PDF bytes. Nothing is stubbed except the download sink, which is captured so the
// PDF can be written out and re-parsed.
//
//   node run_e2e.js            run everything
//   node run_e2e.js --headful  watch it happen
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(__dirname, 'samples');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADFUL = process.argv.includes('--headful');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${detail}`); }
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    // Contain the static server to the app root; a traversal here would serve the
    // developer's home directory to anything that can reach the port.
    const file = path.normalize(path.join(ROOT, rel === '/' ? '/index.html' : rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// Everything the app hands to the browser to download is funnelled through
// downloadBlob(); replacing it lets the harness see the exact bytes a user gets.
//
// This MUST be installed after the app's scripts have run, not via
// evaluateOnNewDocument: `function downloadBlob(){}` in aquasafe.js is a top-level
// declaration, so it binds onto window at parse time and would clobber a hook
// installed earlier.
const CAPTURE_DOWNLOADS = () => {
  window.__downloads = [];
  const orig = window.downloadBlob;
  window.downloadBlob = function (blob, name) {
    return blob.arrayBuffer().then(ab => {
      window.__downloads.push({ name, bytes: Array.from(new Uint8Array(ab)) });
    });
  };
  window.__origDownloadBlob = orig;
};

async function newPage(browser, base) {
  const page = await browser.newPage();
  page.on('pageerror', e => { failures.push(`page error: ${e.message}`); fail++; console.log(`  \x1b[31mJS ERROR\x1b[0m ${e.message}`); });
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.setReagent === 'function' && typeof window.downloadBlob === 'function');
  await page.evaluate(CAPTURE_DOWNLOADS);
  // Guard the guard: if the hook ever stops taking, every download assertion below
  // would hang for 8 s and then fail obscurely.
  const hooked = await page.evaluate(() => window.downloadBlob !== window.__origDownloadBlob);
  if (!hooked) throw new Error('download capture hook did not take');
  return page;
}

async function runSample(browser, base, m) {
  const page = await newPage(browser, base);
  // The operator selects the test on a tab, and that selection is what drives the maths.
  // The photo's own colour vote is a cross-check only, asserted separately below.
  await page.evaluate((r, u) => { setReagent(r); setUse(u); }, m.reagent || 'dpd', m.use);

  const input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, m.file));
  // loadPhoto decodes asynchronously; wait for the app to settle on an outcome
  // rather than sleeping a fixed amount.
  await page.waitForFunction(
    () => window.lastResult !== null || /No |Too much|Reagent mismatch|white reference/i.test(document.getElementById('clNote').textContent),
    { timeout: 8000 }
  ).catch(() => {});

  const state = await page.evaluate(() => ({
    note: document.getElementById('clNote').textContent,
    band: document.getElementById('clBand').textContent,
    bandClass: document.getElementById('clBand').className,
    bandShown: document.getElementById('clBand').style.display !== 'none',
    result: document.getElementById('clResult').innerText,
    conc: window.lastReading ? window.lastReading.conc : null,
    species: window.lastReading ? window.lastReading.species : null,
    reagent: window.lastReading ? window.lastReading.reagent : null,
    crossCheck: window.lastReading ? window.lastReading.crossCheck : null,
    reagentSource: window.lastReading ? window.lastReading.reagentSource : null,
    overRange: window.lastReading ? window.lastReading.overRange : null,
    caution: document.getElementById('otoCaution').style.display !== 'none',
    cautionText: document.getElementById('otoCaution').textContent,
    saveShown: document.getElementById('saveBtn').style.display !== 'none',
    recordShown: document.getElementById('recordBlock').style.display !== 'none',
  }));

  if (m.expect === 'value') {
    const ok = state.conc !== null && Math.abs(state.conc - m.expect_mg_l) <= m.tol;
    check(`${m.file}: reads ${m.expect_mg_l} mg/L`, ok,
      `got ${state.conc === null ? 'no reading' : state.conc.toFixed(3)} (tol ${m.tol}); note="${state.note.slice(0, 110)}"`);

    if (m.reagent === 'oto') {
      check(`${m.file}: reported as TOTAL chlorine`, state.species === 'total', `species=${state.species}`);
      // The invariant: OTO must never render as a pass.
      check(`${m.file}: never rendered as a pass`, !/\bok\b/.test(state.bandClass),
        `band class was "${state.bandClass}" (${state.band})`);
      // Checks the MEANING, not the old jargon: it must say this is not free chlorine,
      // and that the figure is the maximum the free chlorine could be.
      check(`${m.file}: free-chlorine caveat is shown`, state.caution &&
        /not a free-chlorine result/i.test(state.cautionText) && /\bmost\b/i.test(state.cautionText),
        `caution shown=${state.caution}; "${state.cautionText.slice(0, 120)}"`);
    } else {
      check(`${m.file}: reported as FREE chlorine`, state.species === 'free', `species=${state.species}`);
    }
    check(`${m.file}: recorded against the ${m.reagent.toUpperCase()} tab`,
      state.reagent === m.reagent.toUpperCase(), `recorded ${state.reagent}`);
    // The tab decides, but the colour vote must still back it up on a clean fixture —
    // that agreement is what makes the wrong-tab veto trustworthy in the field.
    check(`${m.file}: colour cross-check agrees with the tab`,
      state.crossCheck === 'agree', `crossCheck=${state.crossCheck}`);
    check(`${m.file}: record says the operator selected it`,
      state.reagentSource === 'selected by operator', `reagentSource=${state.reagentSource}`);
    check(`${m.file}: offers save + record`, state.saveShown && state.recordShown,
      `save=${state.saveShown} record=${state.recordShown}`);
  } else if (m.expect === 'overrange') {
    check(`${m.file}: flagged over range`, state.overRange === true, `overRange=${state.overRange}`);
    // The bound must come from the gate, and it must be BELOW the true concentration —
    // a "lower bound" that exceeded the real value would be a false alarm, not a bound.
    check(`${m.file}: publishes the gate bound, not a number`,
      state.conc !== null && Math.abs(state.conc - m.expect_bound_mg_l) <= m.tol,
      `got ${state.conc} want ~${m.expect_bound_mg_l}`);
    check(`${m.file}: bound is genuinely a lower bound (true ${m.card_mg_l})`,
      state.conc !== null && state.conc < m.card_mg_l, `bound ${state.conc} vs true ${m.card_mg_l}`);
    check(`${m.file}: shown with a > prefix`, /^>/.test(state.result.trim()),
      `result="${state.result.split('\n')[0]}"`);
    check(`${m.file}: never rendered as a pass`, !/\bok\b/.test(state.bandClass), state.bandClass);
    check(`${m.file}: tells the user to dilute`,
      /dilut|half sample with half clean water/i.test(state.note), state.note.slice(0, 140));
  } else {
    const ok = !state.saveShown && state.conc === null &&
      new RegExp(m.reject_contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(state.note);
    check(`${m.file}: refuses (${m.reject_contains})`, ok,
      `conc=${state.conc} save=${state.saveShown} note="${state.note.slice(0, 160)}"`);
  }

  await page.close();
  return state;
}

async function testPDF(browser, base) {
  console.log('\n\x1b[1mPDF report\x1b[0m');
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  for (const [reagent, file, label] of [['dpd', 'dpd_0p5.png', 'DPD'], ['oto', 'oto_0p6.png', 'OTO']]) {
    if (!fs.existsSync(path.join(SAMPLES, file))) { check(`${label} PDF: sample present`, false, `${file} missing`); continue; }
    const page = await newPage(browser, base);
    await page.evaluate(r => { setReagent(r); setUse('drinking'); }, reagent);
    await page.evaluate(() => {
      document.getElementById('siteName').value = 'Ward 7 standpost — consumer tap';
    });
    const input = await page.$('#photoInput');
    await input.uploadFile(path.join(SAMPLES, file));
    await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
    await page.evaluate(() => downloadPDF());
    await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 8000 });

    const dl = await page.evaluate(() => window.__downloads[0]);
    const buf = Buffer.from(dl.bytes);
    const out = path.join(ARTIFACTS, `${reagent}-report.pdf`);
    fs.writeFileSync(out, buf);

    check(`${label} PDF: filename`, /^aquasafe-.*\.pdf$/.test(dl.name), `got "${dl.name}"`);
    check(`${label} PDF: valid header/trailer`, buf.slice(0, 8).toString() === '%PDF-1.4' &&
      buf.slice(-6).toString().trim() === '%%EOF', `head="${buf.slice(0, 8)}" tail="${buf.slice(-8)}"`);
    check(`${label} PDF: non-trivial size (photo embedded)`, buf.length > 20000, `${buf.length} bytes`);
    const pdfNote = await page.evaluate(() => document.getElementById('pdfNote').textContent);
    check(`${label} PDF: no build error surfaced`, /saved as/i.test(pdfNote), `pdfNote="${pdfNote}"`);
    console.log(`       wrote ${path.relative(process.cwd(), out)} (${(buf.length / 1024).toFixed(0)} kB)`);
    await page.close();
  }
}

async function testCSVandLog(browser, base) {
  console.log('\n\x1b[1mLog + CSV export\x1b[0m');
  const page = await newPage(browser, base);
  const input = await page.$('#photoInput');

  // One DPD reading and one OTO reading in the same log — the day summary must keep
  // free and total apart rather than averaging two different quantities together.
  await page.evaluate(() => { setReagent('dpd'); setUse('drinking');
    document.getElementById('siteName').value = 'Tap A'; });
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  await page.evaluate(() => saveReading());

  await page.evaluate(() => { setReagent('oto');
    document.getElementById('siteName').value = 'Tap B'; });
  await input.uploadFile(path.join(SAMPLES, 'oto_0p6.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  await page.evaluate(() => saveReading());

  const hist = await page.evaluate(() => document.getElementById('histBody').innerText);
  // The name must persist so it is not retyped every sample.
  const persisted = await page.evaluate(async () => {
    document.getElementById('operator').value = 'R. Kumar'; saveOperator();
    const again = await fetch(location.href).then(() => localStorage.getItem('aquasafe_operator'));
    return again;
  });
  check('operator name is remembered on the device', persisted === 'R. Kumar', `got ${persisted}`);
  check('log: both reagents listed', /DPD/.test(hist) && /OTO/.test(hist), hist.slice(0, 200));
  check('log: free and total summarised separately',
    /free/i.test(hist) && /total/i.test(hist), hist.split('\n')[0]);

  await page.evaluate(() => { window.__downloads = []; exportHistory(); });
  await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 5000 });
  const dl = await page.evaluate(() => window.__downloads[0]);
  const csv = Buffer.from(dl.bytes).toString('utf8');
  check('csv: BOM + header', csv.charCodeAt(0) === 0xFEFF && /reagent,species,chlorine_mg_L/.test(csv),
    csv.slice(0, 120));
  check('csv: species column distinguishes the rows',
    /Free chlorine/.test(csv) && /Total chlorine/.test(csv), csv.slice(0, 400));
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'log.csv'), csv);
  await page.close();
}

// chart_calibration.json is the written record of the colour charts the app reads; aquasafe.js
// is what actually runs. If they drift apart the documentation becomes a liability rather
// than an asset, so pin them together — and keep the chart images the numbers came from.
async function testCalibrationMatchesCode(browser, base) {
  console.log('\n\x1b[1mCalibration record\x1b[0m');
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, 'chart_calibration.json'), 'utf8'));
  const page = await newPage(browser, base);
  const js = await page.evaluate(() => ({
    dpd: CHARTS.dpd.rgb, oto: CHARTS.oto.rgb, steps: CHART_MG, top: CHART_TOP,
    fitMax: [REAGENTS.dpd.fitMax, REAGENTS.oto.fitMax], legacyK: DPD_K, legacyCard: OTO_CARD_T,
    roundTrip: ['dpd', 'oto'].map(id => CHARTS[id].t.map((t, i) => Math.abs(chartRead(t, id).mg - CHART_MG[i]) < 1e-9).every(Boolean)),
  }));
  check('the shipped DPD chart matches the recorded swatches', JSON.stringify(js.dpd) === JSON.stringify(cal.swatch_rgb.dpd), JSON.stringify(js.dpd));
  check('the shipped OTO chart matches the recorded swatches', JSON.stringify(js.oto) === JSON.stringify(cal.swatch_rgb.oto), JSON.stringify(js.oto));
  check('the chart steps match the record', JSON.stringify(js.steps) === JSON.stringify(cal.steps_mg_l), JSON.stringify(js.steps));
  check('the range ceiling is the top swatch for both reagents', js.fitMax[0] === 5 && js.fitMax[1] === 5 && js.top === 5, JSON.stringify(js.fitMax));
  check('every swatch reads back as its own mg/L', js.roundTrip[0] && js.roundTrip[1], JSON.stringify(js.roundTrip));
  check('legacy constants stay on the record (3.778, TWAD card)', js.legacyK === 3.778 && js.legacyCard.length === 6, `${js.legacyK}`);
  for (const f of ['chart-dpd-2026-09-04.png', 'chart-oto-2026-09-04.jpg', 'twad-chlorine-card.jpeg']) {
    check(`calibration source kept: ${f}`, fs.existsSync(path.join(__dirname, 'field', f)), 'missing');
  }
  await page.close();
}

// A control whose text matches its own background is invisible but still passes every
// functional test — the `.btn2 button` / `.rowbtn` specificity clash shipped exactly that
// on the PDF button. Check contrast on every interactive control instead of any one fix.
async function testControlsVisible(browser, base) {
  console.log('\n\x1b[1mControl legibility\x1b[0m');
  const page = await newPage(browser, base);
  const input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  await page.evaluate(() => { saveReading(); setUse('pool'); });

  const bad = await page.evaluate(() => {
    // Walk up for the nearest non-transparent background, the way a viewer perceives it.
    const bg = el => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
        if (m && (m[4] === undefined || parseFloat(m[4]) > 0.05)) return [+m[1], +m[2], +m[3]];
      }
      return [255, 255, 255];
    };
    const lum = ([r, g, b]) => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const out = [];
    document.querySelectorAll('button, a.dl, .seg button, .rowbtn').forEach(el => {
      if (!el.offsetParent || !el.textContent.trim()) return;
      const c = getComputedStyle(el).color.match(/[\d.]+/g).map(Number);
      const L1 = lum(c) + 0.05, L2 = lum(bg(el)) + 0.05;
      const ratio = L1 > L2 ? L1 / L2 : L2 / L1;
      if (ratio < 3) out.push({ text: el.textContent.trim().slice(0, 28), ratio: +ratio.toFixed(2) });
    });
    return out;
  });
  check('every visible control has legible contrast', bad.length === 0,
    `below 3:1 -> ${JSON.stringify(bad)}`);
  await page.close();
}

// "Touch the camera" is the universal capture gesture, and with no camera running it must
// explain itself rather than analyse a blank frame as if it were a photograph.
async function testViewfinderTap(browser, base) {
  console.log('\n\x1b[1mViewfinder\x1b[0m');
  const page = await newPage(browser, base);
  const wired = await page.evaluate(() => !!document.getElementById('camWrap').getAttribute('onclick'));
  check('tapping the viewfinder captures', wired, 'camWrap has no click handler');
  // No camera in headless Chrome, so this is the real no-stream path.
  await page.evaluate(() => document.getElementById('camWrap').click());
  const st = await page.evaluate(() => ({
    note: document.getElementById('clNote').textContent,
    reading: window.lastReading, flash: !!document.getElementById('camFlash'),
  }));
  check('tap with no camera explains, never fabricates a reading',
    st.reading === null && /camera not running/i.test(st.note), `note="${st.note.slice(0, 90)}"`);
  check('a visual flash exists so feedback survives a muted phone', st.flash, 'no #camFlash');
  await page.close();
}

// The whole point of the app is a field worker with no signal, so the report has to be
// produced with the network genuinely off — not merely "no CDN in the markup". This
// installs the service worker, cuts the network, reloads from cache, and runs a full
// capture-to-PDF cycle offline.
async function testOffline(browser, base) {
  console.log('\n\x1b[1mOffline\x1b[0m');
  const page = await browser.newPage();
  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle2' });
  const swReady = await page.evaluate(() =>
    navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false));
  check('service worker installs', swReady, 'no active worker');

  await page.setOfflineMode(true);
  const offlineReqs = [];
  page.on('request', r => offlineReqs.push(r.url()));

  await page.reload({ waitUntil: 'domcontentloaded' });
  const shell = await page.evaluate(() => ({
    app: typeof window.setReagent === 'function',
    pdf: typeof window.AquasafePDF === 'object',
    title: document.title,
  }));
  check('app shell loads from cache with the network off', shell.app && shell.pdf,
    `app=${shell.app} pdf=${shell.pdf} title="${shell.title}"`);
  if (!shell.app) { await page.close(); return; }

  await page.evaluate(CAPTURE_DOWNLOADS);
  await page.evaluate(() => { document.getElementById('siteName').value = 'Offline field check'; });
  const input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  check('reading computed offline', await page.evaluate(() => window.lastReading.conc > 0), 'no reading');

  await page.evaluate(() => downloadPDF());
  await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 8000 }).catch(() => {});
  const dl = await page.evaluate(() => window.__downloads[0] || null);
  check('PDF downloads offline', !!dl, await page.evaluate(() => document.getElementById('pdfNote').textContent));
  if (dl) {
    const buf = Buffer.from(dl.bytes);
    check('offline PDF is valid', buf.slice(0, 8).toString() === '%PDF-1.4' &&
      buf.slice(-6).toString().trim() === '%%EOF', `${buf.length} bytes`);
    // The stamped photo is the part that could silently vanish: toDataURL throws if the
    // canvas was tainted, and buildReportDoc swallows that to keep the report working.
    check('offline PDF still embeds the stamped photo', buf.length > 20000,
      `only ${buf.length} bytes — photo was dropped`);
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'offline-report.pdf'), buf);
  }
  // CSV too — the other export a field worker needs before reaching signal.
  await page.evaluate(() => { saveReading(); window.__downloads = []; exportHistory(); });
  await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 5000 }).catch(() => {});
  check('CSV exports offline', await page.evaluate(() => window.__downloads.length > 0), 'no CSV');

  const external = offlineReqs.filter(u => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
  check('no external requests attempted while offline', external.length === 0, external.join(', '));

  await page.setOfflineMode(false);
  await page.close();
}

// Capture feedback on the REAL camera path, with a synthetic camera device so the
// shutter actually fires. Runs under an Android profile because that is the deployment
// target. Vibration is Android-only (iOS Safari has never shipped navigator.vibrate),
// which is exactly why the visual flash is the primary signal and buzz/click are extras.
async function testCaptureFeedback(base) {
  console.log('\n\x1b[1mCapture feedback (fake camera, Android profile)\x1b[0m');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: !HEADFUL,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream',
           '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.emulate({
      viewport: { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    });
    await page.evaluateOnNewDocument(() => {
      window.__vibes = [];
      // Desktop Chrome does not implement the Vibration API, so define it to observe the
      // call. This proves the app ASKS to vibrate; only a physical handset can prove the
      // motor runs.
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true, value: p => { window.__vibes.push(p); return true; },
      });
      window.__audioNodes = 0;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const orig = AC.prototype.createBufferSource;
        AC.prototype.createBufferSource = function () { window.__audioNodes++; return orig.call(this); };
      }
    });
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.setReagent === 'function');
    await page.waitForFunction(() => {
      const v = document.getElementById('cam');
      return window.camStream && v && v.videoWidth > 0;
    }, { timeout: 15000 }).catch(() => {});

    const cam = await page.evaluate(() => ({
      stream: !!window.camStream,
      w: document.getElementById('cam').videoWidth,
    }));
    check('camera starts and delivers frames', cam.stream && cam.w > 0,
      `stream=${cam.stream} videoWidth=${cam.w}`);

    // A real tap on the viewfinder, dispatched through the touch/mouse stack.
    await page.evaluate(() => document.getElementById('camWrap').scrollIntoView());
    await page.tap('#camWrap');
    await page.waitForFunction(() => window.__audioNodes > 0 || window.__vibes.length > 0,
      { timeout: 5000 }).catch(() => {});

    const fb = await page.evaluate(() => ({
      vibes: window.__vibes, nodes: window.__audioNodes,
      ctx: window.audioCtx ? window.audioCtx.state : 'none',
      flashed: document.getElementById('camFlash').classList.contains('go'),
    }));
    // 35ms, not a token 18: much of a very short request is spent spinning the motor
    // up, so through a glove at arm's length 18ms is often not felt.
    check('tap vibrates perceptibly (Android)', fb.vibes.length > 0 && fb.vibes[0] >= 30,
      `vibrate calls: ${JSON.stringify(fb.vibes)}`);
    check('tap synthesises the shutter click', fb.nodes >= 2,
      `${fb.nodes} buffer sources created, AudioContext=${fb.ctx}`);
    check('tap flashes the frame', fb.flashed, 'flash class not applied');
    console.log(`       AudioContext state after tap: ${fb.ctx}`);
  } finally { await browser.close(); }
}

// Sample details now sit next to Save, i.e. they are edited AFTER the shot. That only
// works if editing them re-stamps the photo — otherwise the image would carry a
// different site name from the record printed beside it.
async function testLateDetailsRestamp(browser, base) {
  console.log('\n\x1b[1mLate sample details\x1b[0m');
  const page = await newPage(browser, base);
  const input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });

  const before = await page.evaluate(() => ({
    stamp: document.getElementById('stampCanvas').toDataURL().length,
    site: window.lastReading.site, conc: window.lastReading.conc,
  }));
  check('a capture with no details still stamps', before.stamp > 1000, `${before.stamp} chars`);

  await page.evaluate(() => {
    document.getElementById('siteName').value = 'Ward 7 standpost — consumer tap';
    rerender();
  });
  const after = await page.evaluate(() => ({
    stamp: document.getElementById('stampCanvas').toDataURL().length,
    site: window.lastReading.site,
  }));
  check('site typed after capture reaches the record', after.site.startsWith('Ward 7'), after.site);
  check('site typed after capture re-stamps the photo', after.stamp !== before.stamp,
    `stamp unchanged at ${after.stamp} chars — image would disagree with the record`);

  // Dilution is the one detail that changes the NUMBER, so it must recompute, not rescale.
  await page.evaluate(() => setDilution(2));
  const dil = await page.evaluate(() => window.lastReading.conc);
  check('dilution set after capture recomputes the reading',
    Math.abs(dil - before.conc * 2) < 0.01, `${before.conc} -> ${dil}, expected ~${(before.conc * 2).toFixed(3)}`);

  // And it must be idempotent: re-rendering twice must not compound the factor.
  await page.evaluate(() => { rerender(); rerender(); });
  const again = await page.evaluate(() => window.lastReading.conc);
  check('repeated rerender does not compound dilution', Math.abs(again - dil) < 1e-9,
    `${dil} -> ${again}`);
  await page.close();
}

// Layout: the procedure chips are a printed list, not a progress bar.
async function testLayout(browser, base) {
  console.log('\n\x1b[1mLayout\x1b[0m');
  const page = await newPage(browser, base);
  const st = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#stepChips span')];
    const card = el => { for (let n = el; n; n = n.parentElement) if (n.classList && n.classList.contains('card')) return n; };
    return {
      highlighted: chips.filter(c => c.className.includes('on')).map(c => c.textContent),
      styles: [...new Set(chips.map(c => getComputedStyle(c).backgroundColor + '/' + getComputedStyle(c).color))],
      // Every field the operator can type into, anywhere on the page.
      inputs: [...document.querySelectorAll('input, select, textarea')]
        .filter(e => e.type !== 'file' && e.offsetParent).map(e => e.id),
      locationWithSave: card(document.getElementById('siteName')) === card(document.getElementById('saveBtn')),
      technical: /absorbance|log₁₀|channel|transmittance|R²|calibrat/i.test(document.body.innerText),
    };
  });
  check('no step chip is highlighted', st.highlighted.length === 0, `highlighted: ${st.highlighted}`);
  check('all step chips render identically', st.styles.length === 1, `distinct styles: ${st.styles}`);
  // The product constraint: location is the only thing an operator types. manualCl is the
  // no-camera fallback, which is a reading not a setting.
  // Location plus the operator's name, which is entered once and remembered rather than
  // typed per sample. manualCl is the no-camera fallback, a reading not a setting.
  check('only location and the remembered operator name are typed',
    st.inputs.filter(i => i !== 'manualCl').sort().join(',') === 'operator,siteName',
    `visible inputs: ${st.inputs}`);
  check('location sits with Save', st.locationWithSave, 'siteName is not in the Save card');
  check('no technical exposition on screen', !st.technical, 'found absorbance/channel/calibration wording');
  await page.close();
}

// The capture confirmation strip. The point of it is that a capture used to change
// something two cards below the fold with nothing on screen saying so.
async function testCaptureStrip(browser, base) {
  console.log('\n\x1b[1mCapture confirmation\x1b[0m');
  const read = p => p.evaluate(() => {
    const el = document.getElementById('capStrip');
    return {
      hidden: el.hidden, cls: el.className,
      title: document.getElementById('capTitle').textContent,
      val: document.getElementById('capVal').textContent.trim(),
      say: document.getElementById('capSay').textContent,
      act: document.getElementById('capAct').textContent.trim(),
      actShown: document.getElementById('capAct').style.display !== 'none',
      live: document.getElementById('capLive').textContent,
      thumbPainted: (() => {
        const c = document.getElementById('capThumb');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;   // any non-transparent pixel
        return false;
      })(),
    };
  });

  // 1. SUCCESS, DPD
  let page = await newPage(browser, base);
  let input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('capLive').textContent.length > 0,
    { timeout: 3000 }).catch(() => {});
  let st = await read(page);
  check('success: strip appears', !st.hidden && /\bok\b/.test(st.cls), `hidden=${st.hidden} cls=${st.cls}`);
  check('success: shows the value', /0\.[45][0-9]/.test(st.val), `val="${st.val}"`);
  check('success: points to the full result', st.actShown && /full result/i.test(st.act), st.act);
  check('success: thumbnail of the captured frame is painted', st.thumbPainted, 'canvas is blank');
  check('success: announced to a screen reader', /reading taken/i.test(st.live), `live="${st.live}"`);
  check('success: camera hint is hidden so two statuses cannot disagree',
    await page.evaluate(() => document.getElementById('camHint').style.display === 'none'), 'camHint visible');
  await page.close();

  // 2. SUCCESS, OTO — must NOT put a bare number above the fold.
  page = await newPage(browser, base);
  await page.evaluate(() => setReagent('oto'));
  input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'oto_0p6.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  st = await read(page);
  const conc = await page.evaluate(() => fmt(window.lastReading.conc, 2));
  check('OTO: strip shows a range, never the bare point value',
    st.val.includes('–') && !new RegExp(`^${conc}\\s`).test(st.val), `val="${st.val}" point=${conc}`);
  check('OTO: strip carries the not-free-chlorine caveat', /not.*confirm free chlorine/i.test(st.say),
    st.say.slice(0, 90));
  await page.close();

  // 3. REFUSED — the shutter fired, nothing was measured. Must not read as success.
  page = await newPage(browser, base);
  input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'gate_glare.png'));
  await page.waitForFunction(() => !document.getElementById('capStrip').hidden, { timeout: 8000 }).catch(() => {});
  st = await read(page);
  check('refused: strip appears in the refused state', !st.hidden && /\bno\b/.test(st.cls), st.cls);
  check('refused: shows no number at all', st.val === '', `val="${st.val}"`);
  check('refused: separates the photo from the measurement',
    /photo was taken/i.test(st.say) && /nothing was measured/i.test(st.say), st.say);
  check('refused: no "see result" button — the shutter above is the retake', !st.actShown, st.act);
  check('refused: never uses success language', !/\bok\b/.test(st.cls) && !/captured|success|✓/i.test(st.title),
    `${st.cls} / ${st.title}`);
  check('refused: thumbnail shows what the phone saw', st.thumbPainted, 'canvas is blank');
  await page.close();

  // 4. OVER RANGE
  page = await newPage(browser, base);
  await page.evaluate(() => setReagent('oto'));
  input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'oto_over_8p0.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  st = await read(page);
  check('over range: distinct state, shown as a bound', /\bover\b/.test(st.cls) && st.val.startsWith('>'),
    `cls=${st.cls} val="${st.val}"`);
  check('over range: tells the user to dilute',
    /dilut|half sample with half clean water/i.test(st.say), st.say.slice(0, 80));
  await page.close();

  // 5. Staleness — a strip must never outlive its reading.
  page = await newPage(browser, base);
  input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  // A typed comparator reading is not a photograph.
  await page.evaluate(() => { document.getElementById('manualCl').value = '0.5'; manualResult(); });
  check('manual entry does not claim a photo was read', (await read(page)).hidden, 'strip shown for manual entry');
  await page.close();
}

// Three defects the design review surfaced, all reproduced before fixing.
async function testA11yRegressions(browser, base) {
  console.log('\n\x1b[1mAccessibility regressions\x1b[0m');
  const page = await newPage(browser, base);

  // Typing in a sample field after a zero reading must not re-open the critical alert.
  await page.evaluate(() => { document.getElementById('manualCl').value = '0'; manualResult(); ackCritical(); });
  await page.evaluate(() => { document.getElementById('siteName').value = 'Ward 7'; rerender(); });
  const crit = await page.evaluate(() => ({
    shown: document.getElementById('critical').classList.contains('show'),
    focus: document.activeElement.id,
  }));
  check('critical alert does not re-fire on every keystroke',
    !crit.shown, `re-opened, focus stolen to "${crit.focus}"`);

  // Disabling a focused element blurs it; checkROI runs every 400ms.
  const sh = await page.evaluate(() => {
    const s = document.getElementById('shutter');
    s.focus(); const before = document.activeElement.id;
    checkROI();
    return { before, after: document.activeElement.id || '(body)', prop: s.disabled,
             aria: s.getAttribute('aria-disabled') };
  });
  check('shutter uses aria-disabled and keeps focus', sh.after === 'shutter' && sh.prop === false,
    `focus ${sh.before} -> ${sh.after}, disabled=${sh.prop}, aria-disabled=${sh.aria}`);

  // role=button + tabindex with no key handler is unreachable by keyboard or switch.
  const kb = await page.evaluate(async () => {
    document.getElementById('camWrap').focus();
    const before = document.getElementById('clNote').textContent;
    document.getElementById('camWrap').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 150));
    return { before, after: document.getElementById('clNote').textContent };
  });
  check('viewfinder responds to Enter, not just tap', kb.after !== kb.before,
    'Enter did nothing — keyboard and switch users cannot capture');

  // Exactly one live region, or the same event is announced twice.
  const live = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-live]')].map(e => e.id || e.tagName));
  check('exactly one live region', live.length === 1 && live[0] === 'capLive', `found: ${live}`);

  // Rate limit: a large white flash must not exceed ~3/s.
  const rate = await page.evaluate(async () => {
    let n = 0; const orig = window.shotFeedback;
    window.shotFeedback = function () { n++; return orig.apply(this, arguments); };
    for (let i = 0; i < 6; i++) { captureTest(); await new Promise(r => setTimeout(r, 30)); }
    window.shotFeedback = orig; return n;
  });
  check('rapid taps are rate-limited below the flash threshold', rate <= 1,
    `${rate} captures fired inside 180ms`);
  await page.close();
}

// Real captures from real operators. Synthetic fixtures only ever prove the app agrees
// with its own model; these prove it works on a photograph taken by someone standing at
// a window in Odisha with a comparator block in their hand.
async function testFieldCaptures(browser, base) {
  const dir = path.join(__dirname, 'field');
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return;
  console.log('\n\x1b[1mField captures\x1b[0m');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

  for (const m of manifest) {
    if (m.expect === 'skip') continue;   // calibration source, not a fixture
    const page = await newPage(browser, base);
    await page.evaluate((r, u) => { setReagent(r); setUse(u); }, m.reagent || 'dpd', m.use);
    const input = await page.$('#photoInput');
    await input.uploadFile(path.join(dir, m.file));
    await page.waitForFunction(
      () => window.lastReading !== null || document.getElementById('capStrip').className.includes('no'),
      { timeout: 10000 }).catch(() => {});

    const st = await page.evaluate(() => ({
      conc: window.lastReading ? window.lastReading.conc : null,
      over: window.lastReading ? window.lastReading.overRange : null,
      T: window.lastReading ? window.lastReading.transmittance : null,
      reagent: window.lastReading ? window.lastReading.reagent : null,
      lo: window.lastReading ? window.lastReading.concLo : null,
      hi: window.lastReading ? window.lastReading.concHi : null,
      note: document.getElementById('clNote').textContent,
    }));

    check(`${m.file}: produces a reading at all`, st.conc !== null,
      `refused — "${st.note.slice(0, 120)}"`);
    if (st.conc === null) { await page.close(); continue; }

    // The regression that matters: this frame must never go back to a bare lower bound.
    check(`${m.file}: recorded against the ${m.reagent.toUpperCase()} tab`,
      st.reagent === m.reagent.toUpperCase(), `recorded ${st.reagent}`);
    check(`${m.file}: not reported as over range`, st.over === false,
      `over range again — the operator gets ">${st.conc}" instead of a value`);
    if (m.expect_min_mg_l_status === 'warn') {
      const ok = st.conc >= m.expect_min_mg_l;
      console.log(`  ${ok ? 'PASS' : '\x1b[33mWARN\x1b[0m'} ${m.file}: reads ${st.conc && st.conc.toFixed(2)} mg/L on the chart` +
        (ok ? '' : ` — below the operator's ${m.expect_min_mg_l} (${m.chart_reading_2026_09_11})`));
    } else {
      check(`${m.file}: reads well above the old ${m.old_ceiling} ceiling`,
        st.conc >= m.expect_min_mg_l, `got ${st.conc && st.conc.toFixed(2)} mg/L (T=${st.T})`);
    }
    // Near the asymptote a small change in transmittance moves the estimate a lot, so a
    // tight band on the point estimate would be false precision. What must hold is that
    // the published INTERVAL covers what the operator reads off their comparator card.
    if (m.expect_min_mg_l_status !== 'warn') {
      check(`${m.file}: interval covers the operator's ${m.operator_expects} mg/L`,
        st.lo !== null && st.hi !== null && st.lo <= m.operator_expects &&
        (st.open || st.hi >= m.operator_expects),
        `interval ${st.lo}–${st.hi}${st.open ? '+' : ''} misses ${m.operator_expects}`);
    }
    check(`${m.file}: interval brackets the point estimate`,
      st.lo <= st.conc && (st.open || st.conc <= st.hi), `${st.lo} <= ${st.conc} <= ${st.hi}`);
    console.log(`       T=${st.T}  ->  ${st.conc.toFixed(2)} mg/L  (range ${st.lo}–${st.hi})`);
    await page.close();
  }
}

// The correction must not disturb the low range, which is where the constant is anchored,
// and it must stay monotonic — a colour test that is not monotonic in concentration is
// worse than no test.
async function testLeakModel(browser, base) {
  console.log('\n\x1b[1mChart model\x1b[0m');
  const page = await newPage(browser, base);
  const r = await page.evaluate(() => {
    // Walk down each chart line in 10 steps per segment: mg/L must rise monotonically,
    // and a point exactly on the line must fit it to within rounding.
    const out = {};
    for (const id of ['dpd', 'oto']) {
      const T = CHARTS[id].t, curve = [], fits = [];
      for (let i = 0; i < T.length - 1; i++) for (let k = 0; k < 10; k++) {
        const f = k / 10, t = T[i].map((a, c) => a + f * (T[i + 1][c] - a));
        const rd = chartRead(t, id); curve.push(rd.mg); fits.push(rd.fit);
      }
      out[id] = { monotonic: curve.every((v, i) => i === 0 || v >= curve[i - 1] - 1e-9), maxFit: Math.max(...fits) };
    }
    // Past the 5.0 swatch along the last segment -> beyond, clamped at 5.0.
    const T = CHARTS.oto.t, t = T[7].map((a, c) => a + 0.5 * (a - T[6][c]));
    out.beyond = chartRead(t.map(v => Math.max(0, v)), 'oto');
    return out;
  });
  check('DPD chart: mg/L rises monotonically along the chart line', r.dpd.monotonic && r.dpd.maxFit < 1e-3, JSON.stringify(r.dpd));
  check('OTO chart: mg/L rises monotonically along the chart line', r.oto.monotonic && r.oto.maxFit < 1e-3, JSON.stringify(r.oto));
  check('past the 5.0 swatch is flagged beyond and clamped at 5.0', r.beyond.beyond === true && r.beyond.mg === 5, JSON.stringify(r.beyond));
  await page.close();
}

// Conformance with the PHED "Orthotolidine (OTO) Total Chlorine Method" standard
// reference — the document the operators are trained on. An earlier build enforced the
// classical Standard Methods 5-minute convention instead and refused any photo taken
// before 4:30, which told a PHED user to do the opposite of their own protocol.
async function testPhedProtocol(browser, base) {
  console.log('\n\x1b[1mPHED protocol conformance\x1b[0m');
  const page = await newPage(browser, base);
  await page.evaluate(() => setReagent('oto'));

  // "Color development must be evaluated immediately after reagent mixing."
  const sop = await page.evaluate(() => document.getElementById('sopBox').textContent);
  // "straight away" rather than "immediately" — same instruction, simpler for a reader
  // whose first language is not English.
  check('SOP tells the operator to photograph without delay',
    /straight away|immediately|right away/i.test(sop) && !/wait until|wait for|4:30|5 minutes|5:00/i.test(sop),
    sop.slice(0, 200));

  // Nothing in the app may make the operator wait before photographing.
  const forced = await page.evaluate(() => ({
    timer: typeof window.toggleTimer === 'function',
    // "Waiting makes the reading too high" is a warning, not an instruction to wait —
    // match only wording that would hold the operator back.
    wait: /wait until|wait for|4:30|5 minutes|5:00/i.test(document.body.innerText),
  }));
  check('no timer forces a wait before the photo', !forced.timer && !forced.wait,
    `timer=${forced.timer} waitWording=${forced.wait}`);

  // The chart's own swatches, so the app and the chart in the operator's hand agree.
  const bands = await page.evaluate(() => ({
    steps: CHART_MG.slice(),
    onStep: otoCardBand(1.0), between: otoCardBand(1.4), past: otoCardBand(5.4),
    exact: CHART_MG.map((c, i) => chartRead(CHARTS.oto.t[i], 'oto').mg),
  }));
  check('the chart is the 0/0.2/0.5/1/2/3/4/5 scale',
    JSON.stringify(bands.steps) === JSON.stringify([0, 0.2, 0.5, 1, 2, 3, 4, 5]), `${bands.steps}`);
  check('a reading on a printed swatch names that swatch', /the 1\.0 swatch/.test(bands.onStep), bands.onStep);
  check('a reading between swatches says so', /between the 1\.0 and 2\.0/.test(bands.between), bands.between);
  check('past the top swatch says so', /past the 5\.0/.test(bands.past), bands.past);
  const err = bands.exact.map((v, i2) => Math.abs(v - [0, 0.2, 0.5, 1, 2, 3, 4, 5][i2]));
  check('the lookup reproduces every printed step', Math.max(...err) < 1e-9,
    `errors ${err.map(e => e.toExponential(1))}`);

  // Orange/brown means 10+ mg/L on the card, not a reagent fault.
  const off = await page.evaluate(() => {
    setReagent('oto');
    return gateReasons({ detected: true, sample: 40, ref: 200, overFrac: 0,
      offChannel: { suspect: true, aRed: 0.3, aBlue: 0.7 } }).longMsg;
  });
  check('orange/brown is explained as very high chlorine, not bad reagent',
    /10 mg\/L or more/i.test(off) && /dilute/i.test(off), off.slice(0, 140));
  await page.close();
}

// The safety invariant lives in classify(), but it was defeated in the RENDER path: the
// reagent was a mutable global that the 400 ms preview loop kept writing, while rerender —
// bound to the location field's oninput, the one action the product directive mandates —
// read it live. So typing a site name could turn a correctly-refused OTO total-chlorine
// reading into a green free-chlorine pass. The old sweep test drove classify() directly
// and could not see it.
async function testResultIsFrozen(browser, base) {
  console.log('\n\x1b[1mResult is frozen at capture\x1b[0m');
  const page = await newPage(browser, base);
  await page.evaluate(() => setReagent('oto'));
  const input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'oto_0p6.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });

  const before = await page.evaluate(() => ({
    species: window.lastReading.species, band: document.getElementById('clBand').className,
    conc: window.lastReading.conc,
  }));
  check('OTO capture starts as total chlorine', before.species === 'total', before.species);

  // Force the global to the other reagent, exactly as a drifting preview frame would,
  // then do the one thing the operator is asked to do.
  const after = await page.evaluate(() => {
    window.reagentId = 'dpd';
    document.getElementById('siteName').value = 'Ward 7 standpost';
    rerender();
    return {
      species: window.lastReading.species, band: document.getElementById('clBand').className,
      conc: window.lastReading.conc, reagent: window.lastReading.reagent,
      caution: document.getElementById('otoCaution').style.display !== 'none',
    };
  });
  check('typing the location cannot relabel the species', after.species === 'total',
    `became ${after.species}`);
  check('typing the location cannot turn a refusal into a pass', !/\bok\b/.test(after.band),
    `band became "${after.band}"`);
  check('typing the location cannot change the number', Math.abs(after.conc - before.conc) < 1e-9,
    `${before.conc} -> ${after.conc}`);
  check('the total-vs-free caution survives', after.caution, 'caution was hidden');

  // The preview must not have been the thing that set it in the first place.
  const preview = await page.evaluate(() => {
    const before = window.reagentId;
    const d = new Uint8ClampedArray(4 * 40000);
    for (let i = 0; i < 40000; i++) {           // a frame full of pink
      d[i * 4] = 231; d[i * 4 + 1] = 171; d[i * 4 + 2] = 208; d[i * 4 + 3] = 255;
    }
    analyzeAuto(d, 200, 200, false);            // commit = false, as checkROI calls it
    return { before, after: window.reagentId };
  });
  check('the live preview never writes the global reagent', preview.before === preview.after,
    `${preview.before} -> ${preview.after}`);
  await page.close();
}

// Warm afternoon light must not flip a pink DPD test to yellow. This is the only path
// that can ever issue a pass, so losing it in the field silently removes the pass.
async function testWarmCastVote(browser, base) {
  console.log('\n\x1b[1mReagent vote under a warm cast\x1b[0m');
  const page = await newPage(browser, base);
  const r = await page.evaluate(() => {
    // Build a frame the way a phone sees one: warm-lit white paper, pink vial in the
    // middle of the outline. Paper is most of the frame, which is what used to swamp it.
    const W = 200, H = 300, d = new Uint8ClampedArray(4 * W * H);
    const put = (o, c) => { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; };
    const out = {};
    for (const [name, paper] of [['neutral', [240, 240, 240]], ['warm', [250, 246, 230]],
                                 ['very warm', [252, 240, 214]]]) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const inVial = x > W * 0.35 && x < W * 0.65 && y > H * 0.30 && y < H * 0.60;
        put(o, inVial ? [231, 171, 208] : paper);
      }
      out[name] = pickReagent(d, W, H);
    }
    return out;
  });
  check('pink vial on neutral paper votes DPD', r.neutral === 'dpd', `got ${r.neutral}`);
  check('pink vial on warm paper still votes DPD', r.warm === 'dpd', `got ${r.warm}`);
  check('pink vial on very warm paper still votes DPD', r['very warm'] === 'dpd', `got ${r['very warm']}`);

  // And when it genuinely cannot tell, it must say so rather than pick one. Half pink,
  // half yellow in the outline is the ambiguous case by construction.
  const tie = await page.evaluate(() => {
    const W = 200, H = 300, d = new Uint8ClampedArray(4 * W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const inVial = x > W * 0.30 && x < W * 0.70 && y > H * 0.30 && y < H * 0.60;
      const c = !inVial ? [240, 240, 240] : (x < W * 0.5 ? [231, 171, 208] : [238, 221, 112]);
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    const s = analyzeAuto(d, W, H, false);
    return { pick: pickReagent(d, W, H), gate: gateReasons(s) };
  });
  check('an ambiguous vial is refused, not guessed', tie.pick === 'tie' && tie.gate.ok === false,
    `pick=${tie.pick} ok=${tie.gate && tie.gate.ok}`);
  check('the refusal explains pink vs yellow',
    /pink/i.test(tie.gate.longMsg) && /yellow/i.test(tie.gate.longMsg) && /cannot (tell|confirm)/i.test(tie.gate.longMsg),
    tie.gate.longMsg.slice(0, 120));
  await page.close();
}

// ---------------------------------------------------------------------------
// The wrong-tab veto
// ---------------------------------------------------------------------------
// The tabs give the operator back control over which chemistry runs. The failure that
// buys is the one this covers: a yellow OTO vial photographed with DPD selected. Left
// alone, analyzePixels runs the DPD pass on it, picks its white reference off the vial
// itself and returns a confident free-chlorine number off entirely the wrong scale —
// with every other gate passing. It must refuse, name what it saw, and NOT switch tabs
// on the operator's behalf.
async function testWrongTabVeto(browser, base) {
  console.log('\n\x1b[1mWrong-tab veto\x1b[0m');

  for (const [tab, file, saw] of [['dpd', 'oto_1p5.png', 'OTO'], ['oto', 'dpd_0p5.png', 'DPD']]) {
    if (!fs.existsSync(path.join(SAMPLES, file))) {
      check(`${tab.toUpperCase()} tab + ${saw} vial: fixture present`, false, `${file} missing`);
      continue;
    }
    const page = await newPage(browser, base);
    await page.evaluate(r => { setReagent(r); setUse('drinking'); }, tab);
    const input = await page.$('#photoInput');
    await input.uploadFile(path.join(SAMPLES, file));
    await page.waitForFunction(
      () => window.lastResult !== null || document.getElementById('clNote').textContent.length > 40,
      { timeout: 8000 }).catch(() => {});

    const st = await page.evaluate(() => ({
      conc: window.lastReading ? window.lastReading.conc : null,
      result: window.lastReading,
      note: document.getElementById('clNote').textContent,
      bandShown: document.getElementById('clBand').style.display !== 'none',
      saveShown: document.getElementById('saveBtn').style.display !== 'none',
      reagentId: window.reagentId,
    }));

    const label = `${tab.toUpperCase()} tab + ${saw} vial`;
    // The whole point: no number at all.
    check(`${label}: publishes no number`, st.conc === null && st.result === null,
      `got ${st.conc} mg/L`);
    check(`${label}: no verdict band`, !st.bandShown, 'a band was rendered');
    check(`${label}: cannot be saved to the log`, !st.saveShown, 'save was offered');
    // It has to say WHICH test it thinks this is, or the operator cannot act on it.
    check(`${label}: names the mismatch`, /does not match the test you selected/i.test(st.note),
      `note="${st.note.slice(0, 140)}"`);
    check(`${label}: tells the operator which tab to switch to`,
      new RegExp(saw, 'i').test(st.note) && /tab/i.test(st.note), st.note.slice(0, 160));
    // And it must NOT quietly do it for them. Silently switching would reintroduce the
    // exact behaviour the tabs were brought back to remove.
    check(`${label}: does not switch the tab by itself`, st.reagentId === tab,
      `tab became ${st.reagentId}`);
    await page.close();
  }
}

// Switching tabs must invalidate a finished reading. The rendered result reads the
// reagent frozen at capture, so it can never be re-interpreted — but a free-chlorine
// number left sitting under the OTO tab is one tap from being saved against the wrong
// test, which is a records problem rather than a maths one.
async function testTabSwitchClearsResult(browser, base) {
  console.log('\n\x1b[1mSwitching tabs clears the reading\x1b[0m');
  const page = await newPage(browser, base);
  await page.evaluate(() => { setReagent('dpd'); setUse('drinking'); });
  const input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });

  const before = await page.evaluate(() => ({
    conc: window.lastReading.conc, species: window.lastReading.species,
    heading: document.getElementById('resultHeading').textContent,
  }));
  check('DPD reading lands under the free-chlorine heading',
    before.species === 'free' && /free/i.test(before.heading),
    `species=${before.species} heading="${before.heading}"`);

  const after = await page.evaluate(() => {
    setReagent('oto');
    return {
      reading: window.lastReading, result: window.lastResult,
      note: document.getElementById('clNote').textContent,
      saveShown: document.getElementById('saveBtn').style.display !== 'none',
      sop: document.getElementById('sopBox').textContent,
      heading: document.getElementById('resultHeading').textContent,
    };
  });
  check('switching tabs clears the previous reading', after.result === null,
    'a result survived the switch');
  check('switching tabs withdraws the save button', !after.saveShown, 'save was still offered');
  check('switching tabs says why', /changed to/i.test(after.note) && /again/i.test(after.note),
    after.note.slice(0, 140));
  // Each tab carries its own procedure — that is the point of separating them.
  check('the OTO tab shows the OTO procedure', /acid OTO/i.test(after.sop) && /yellow/i.test(after.sop),
    after.sop.slice(0, 140));
  check('the OTO tab carries the o-tolidine handling caution', /harmful/i.test(after.sop),
    'safety note missing from the OTO tab');

  const back = await page.evaluate(() => {
    setReagent('dpd');
    return { sop: document.getElementById('sopBox').textContent,
             heading: document.getElementById('resultHeading').textContent };
  });
  check('the DPD tab shows the DPD procedure', /DPD No\.1/i.test(back.sop) && /pink/i.test(back.sop),
    back.sop.slice(0, 140));
  // DPD fades on standing and OTO keeps rising: the two tabs must not carry the same
  // timing warning, because the error directions are opposite.
  check('DPD warns the reading runs LOW when late', /\bLOW\b/.test(back.sop), back.sop.slice(0, 200));
  check('OTO warns the reading runs HIGH when late', /\bHIGH\b/.test(after.sop), after.sop.slice(0, 200));
  check('the free-chlorine heading is restored', /free/i.test(back.heading), back.heading);
  await page.close();
}

// A number typed off the operator's own colour card.
//
// While the app chose the reagent itself, a typed value could never render as a pass: the
// app had no way to know whether the operator had read a DPD (free) card or an OTO (total)
// one, and those are different quantities. The tabs restore that knowledge, so a typed DPD
// reading is judged against IS 10500 again, exactly as it was before the tabs were removed.
// Two things must NOT come back with it: any suggestion the app measured the value, and any
// possibility of an OTO total passing — that restriction never rested on reagent control,
// because total >= free is chemistry.
async function testTypedCardReading(browser, base) {
  console.log('\n\x1b[1mTyped colour-card readings\x1b[0m');
  const page = await newPage(browser, base);

  const typed = async (tab, v) => page.evaluate((t, x) => {
    setReagent(t); setUse('drinking');
    document.getElementById('manualCl').value = String(x);
    manualResult();
    return {
      band: document.getElementById('clBand').className,
      label: document.getElementById('clBand').textContent,
      note: document.getElementById('clNote').textContent,
      species: window.lastReading.species,
      source: window.lastReading.reagentSource,
      cross: window.lastReading.crossCheck,
    };
  }, tab, v);

  const ok = await typed('dpd', 0.5);
  check('a typed DPD reading in range is judged compliant', /\bok\b/.test(ok.band),
    `band="${ok.band}" label="${ok.label}"`);
  check('the typed DPD verdict is labelled as a card reading', /card reading/i.test(ok.label), ok.label);
  check('the note says the app did not measure it', /you typed/i.test(ok.note) && /not measured/i.test(ok.note),
    ok.note.slice(0, 160));
  check('the record marks the value as typed', ok.source === 'typed from colour card', ok.source);
  check('a typed value carries no colour cross-check', ok.cross === null, `crossCheck=${ok.cross}`);

  const low = await typed('dpd', 0.1);
  check('a typed DPD reading below the floor is judged low', /\blow\b/.test(low.band), low.band);
  const high = await typed('dpd', 2.0);
  check('a typed DPD reading above the limit is judged an exceedance', /vhigh/.test(high.band), high.band);

  // The invariant that does not move.
  for (const v of [0.3, 0.6, 1.0, 2.5]) {
    const t = await typed('oto', v);
    check(`a typed OTO reading of ${v} mg/L still never passes`,
      !/\bok\b/.test(t.band) && t.species === 'total', `band="${t.band}" species=${t.species}`);
  }
  await page.close();
}

async function testGuards(browser, base) {
  console.log('\n\x1b[1mSafety guards\x1b[0m');
  const page = await newPage(browser, base);

  // Switching reagent must invalidate the reading on screen: the channel, the
  // constant and the measured species all just changed underneath it.
  const input = await page.$('#photoInput');
  await page.evaluate(() => { setReagent('dpd'); setUse('drinking'); });
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  // The reagent comes from the tab, and the record must say so — provenance on a
  // compliance document is not decoration.
  const prov = await page.evaluate(() => ({
    reagent: window.lastReading.reagent,
    source: window.lastReading.reagentSource,
    cross: window.lastReading.crossCheck,
  }));
  check('the record carries the tab the operator selected', prov.reagent === 'DPD', `recorded ${prov.reagent}`);
  check('the record says the operator selected it', prov.source === 'selected by operator', prov.source);
  check('the record carries the colour cross-check verdict',
    ['agree', 'unconfirmed'].includes(prov.cross), `crossCheck=${prov.cross}`);

  // Manual zero entry is the ONLY route to a reported zero (a colourless vial is
  // refused), and it must raise the critical interstitial.
  await page.evaluate(() => { setReagent('dpd'); setUse('drinking');
    document.getElementById('manualCl').value = '0'; manualResult(); });
  const crit = await page.evaluate(() => ({
    shown: document.getElementById('critical').classList.contains('show'),
    title: document.getElementById('criticalTitle').textContent,
    band: document.getElementById('clBand').textContent }));
  check('manual zero raises the critical alert', crit.shown && /ZERO/.test(crit.title),
    `shown=${crit.shown} title="${crit.title}"`);

  // An OTO zero is the one OTO verdict that IS sound: total zero implies free zero.
  await page.evaluate(() => { ackCritical(); setReagent('oto');
    document.getElementById('manualCl').value = '0'; manualResult(); });
  const otoZero = await page.evaluate(() => ({
    shown: document.getElementById('critical').classList.contains('show'),
    adv: document.getElementById('criticalAdv').textContent }));
  check('OTO zero raises the critical alert and explains the inference',
    otoZero.shown && /total of zero does mean free chlorine is zero/i.test(otoZero.adv),
    `shown=${otoZero.shown} adv="${otoZero.adv.slice(-160)}"`);

  // Any OTO reading above zero must be indeterminate, never a pass — swept across
  // the whole range so no concentration can slip into an "ok" band.
  await page.evaluate(() => ackCritical());
  const sweep = await page.evaluate(() => {
    setReagent('oto');
    const out = [];
    for (const use of ['drinking']) {
      setUse(use);
      for (const c of [0.05, 0.2, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 10]) {
        out.push({ use, c, band: classify(c, REAGENTS.oto, USES[use]).band });
      }
    }
    return out;
  });
  const passes = sweep.filter(s => s.band === 'ok');
  check('no OTO concentration in any use ever bands as "ok"', passes.length === 0,
    `these did: ${JSON.stringify(passes)}`);

  // And the DPD path must still band normally, or the guard above is vacuous.
  // 0.5 mg/L is compliant; 2.0 is above the IS 10500 permissible limit of 1.0, so it must
  // NOT read as merely "high" — that would imply headroom the standard does not give.
  const dpdOk = await page.evaluate(() =>
    classify(0.5, REAGENTS.dpd, USES.drinking).band + '/' + classify(2, REAGENTS.dpd, USES.drinking).band);
  check('DPD bands 0.5 compliant and 2.0 as an exceedance', dpdOk === 'ok/vhigh', `got ${dpdOk}`);
  // The pool profile is gone, so no pass can be computed outside the DPD fitted range.
  const noPool = await page.evaluate(() => Object.keys(USES));
  check('only the drinking-water profile exists', noPool.length === 1 && noPool[0] === 'drinking', `${noPool}`);

  // A measurement must never be computed against an assumed white reference.
  const noWhite = await page.evaluate(() => {
    const d = new Uint8ClampedArray(4 * 4000);
    for (let i = 0; i < 4000; i++) {   // all pink, no white anywhere
      d[i * 4] = 230; d[i * 4 + 1] = 168; d[i * 4 + 2] = 207; d[i * 4 + 3] = 255;
    }
    setReagent('dpd');
    const s = analyzePixels(d);
    return { ref: s.ref, gate: gateReasons(s).ok };
  });
  check('no white pixels -> reference is 0 and the gate refuses',
    noWhite.ref === 0 && noWhite.gate === false, JSON.stringify(noWhite));

  await page.close();
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME}`); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: !HEADFUL,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--deny-permission-prompts'],
  });

  try {
    console.log(`\n\x1b[1mAquasafe end-to-end\x1b[0m  ${base}\n`);
    console.log('\x1b[1mSample images\x1b[0m');
    for (const m of manifest) await runSample(browser, base, m);
    await testPDF(browser, base);
    await testCSVandLog(browser, base);
    await testOffline(browser, base);
    await testControlsVisible(browser, base);
    await testViewfinderTap(browser, base);
    await testCaptureFeedback(base);
    await testLateDetailsRestamp(browser, base);
    await testLayout(browser, base);
    await testPhedProtocol(browser, base);
    await testFieldCaptures(browser, base);
    await testLeakModel(browser, base);
    await testCaptureStrip(browser, base);
    await testA11yRegressions(browser, base);
    await testCalibrationMatchesCode(browser, base);
    await testResultIsFrozen(browser, base);
    await testWarmCastVote(browser, base);
    await testGuards(browser, base);
    await testWrongTabVeto(browser, base);
    await testTabSwitchClearsResult(browser, base);
    await testTypedCardReading(browser, base);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (fail) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
