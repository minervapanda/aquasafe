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
