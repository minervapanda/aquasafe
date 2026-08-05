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
  await page.evaluate((r, u) => { setReagent(r); setUse(u); }, m.reagent, m.use);

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
      check(`${m.file}: free-chlorine caveat is shown`, state.caution && /upper bound/i.test(state.cautionText),
        `caution shown=${state.caution}`);
    } else {
      check(`${m.file}: reported as FREE chlorine`, state.species === 'free', `species=${state.species}`);
    }
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
    check(`${m.file}: tells the user to dilute`, /dilut/i.test(state.note), state.note.slice(0, 140));
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
      document.getElementById('temp').value = '28.4';
      document.getElementById('ph').value = '7.35';
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

// oto_calibration.json is the written record of where the constant came from and how
// far it can be trusted; aquasafe.js is what actually runs. If they drift apart the
// documentation becomes a liability rather than an asset, so pin them together.
async function testCalibrationMatchesCode(browser, base) {
  console.log('\n\x1b[1mCalibration record\x1b[0m');
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, 'oto_calibration.json'), 'utf8'));
  const page = await newPage(browser, base);
  const js = await page.evaluate(() => ({
    k: OTO_K, kLo: OTO_K_LO, kHi: OTO_K_HI, satT: OTO_SAT_T, dpdK: DPD_K,
  }));
  check('k_oto matches the record', js.k === cal.k_oto_srgb, `js ${js.k} vs json ${cal.k_oto_srgb}`);
  check('uncertainty bracket matches', js.kLo === cal.bracket[0] && js.kHi === cal.bracket[1],
    `js [${js.kLo},${js.kHi}] vs json [${cal.bracket}]`);
  check('transmittance gate matches', js.satT === cal.range.transmittance_gate,
    `js ${js.satT} vs json ${cal.range.transmittance_gate}`);
  check('DPD constant unchanged from the shipped apps', js.dpdK === 3.778, `got ${js.dpdK}`);
  // The bracket must actually be a bracket, or the published interval is nonsense.
  check('bracket straddles k', js.kLo < js.k && js.k < js.kHi, `${js.kLo} < ${js.k} < ${js.kHi}`);
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
  await page.evaluate(() => { setReagent('dpd'); setUse('drinking');
    document.getElementById('siteName').value = 'Offline field check';
    document.getElementById('ph').value = '7.4'; });
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
  await page.evaluate(() => { document.getElementById('dilution').value = '2'; rerender(); });
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
    const sameCardAsSave = id => card(document.getElementById(id)) === card(document.getElementById('saveBtn'));
    return {
      n: chips.length,
      highlighted: chips.filter(c => c.className.includes('on')).map(c => c.textContent),
      styles: [...new Set(chips.map(c => getComputedStyle(c).backgroundColor + '/' + getComputedStyle(c).color))],
      detailsWithSave: ['siteName', 'temp', 'ph', 'dilution'].filter(sameCardAsSave),
    };
  });
  check('no step chip is highlighted', st.highlighted.length === 0, `highlighted: ${st.highlighted}`);
  check('all step chips render identically', st.styles.length === 1, `distinct styles: ${st.styles}`);
  check('sample details sit in the same card as Save',
    st.detailsWithSave.length === 4, `only ${st.detailsWithSave} moved`);
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
  check('success: shows the value', /0\.4[0-9]/.test(st.val), `val="${st.val}"`);
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
  await input.uploadFile(path.join(SAMPLES, 'oto_over_3p0.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  st = await read(page);
  check('over range: distinct state, shown as a bound', /\bover\b/.test(st.cls) && st.val.startsWith('>'),
    `cls=${st.cls} val="${st.val}"`);
  check('over range: tells the user to dilute', /dilut/i.test(st.say), st.say.slice(0, 80));
  await page.close();

  // 5. Staleness — a strip must never outlive its reading.
  page = await newPage(browser, base);
  input = await page.$('#photoInput');
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  await page.evaluate(() => setReagent('oto'));
  check('switching reagent clears the strip', (await read(page)).hidden, 'strip survived a reagent switch');
  // A typed comparator reading is not a photograph.
  await page.evaluate(() => { setReagent('dpd'); document.getElementById('manualCl').value = '0.5'; manualResult(); });
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

async function testGuards(browser, base) {
  console.log('\n\x1b[1mSafety guards\x1b[0m');
  const page = await newPage(browser, base);

  // Switching reagent must invalidate the reading on screen: the channel, the
  // constant and the measured species all just changed underneath it.
  const input = await page.$('#photoInput');
  await page.evaluate(() => { setReagent('dpd'); setUse('drinking'); });
  await input.uploadFile(path.join(SAMPLES, 'dpd_0p5.png'));
  await page.waitForFunction(() => window.lastReading !== null, { timeout: 8000 });
  await page.evaluate(() => setReagent('oto'));
  const after = await page.evaluate(() => ({
    reading: window.lastReading, save: document.getElementById('saveBtn').style.display,
    note: document.getElementById('clNote').textContent }));
  check('switching reagent clears the stale reading', after.reading === null && after.save === 'none',
    `reading=${JSON.stringify(after.reading)} save=${after.save}`);

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
    for (const use of ['drinking', 'pool']) {
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
  const dpdOk = await page.evaluate(() =>
    classify(0.5, REAGENTS.dpd, USES.drinking).band + '/' + classify(2, REAGENTS.dpd, USES.pool).band);
  check('DPD still bands compliant readings as "ok"', dpdOk === 'ok/ok', `got ${dpdOk}`);

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
    await testCaptureStrip(browser, base);
    await testA11yRegressions(browser, base);
    await testCalibrationMatchesCode(browser, base);
    await testGuards(browser, base);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (fail) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
