// Smoke-test the DEPLOYED site over https: local passes prove the code works, this
// proves what actually shipped works — right paths, right MIME types, SW registers.
const path = require('path');
const puppeteer = require('puppeteer-core');
const URL = process.argv[2] || 'https://minervapanda.github.io/aquasafe/';
(async () => {
  const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage();
  const bad = [];
  p.on('requestfailed', r => bad.push(`${r.url()} ${r.failure().errorText}`));
  p.on('response', r => { if (r.status() >= 400) bad.push(`${r.url()} HTTP ${r.status()}`); });
  p.on('pageerror', e => bad.push(`JS: ${e.message}`));
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => typeof window.setReagent === 'function', { timeout: 15000 });

  await p.evaluate(() => { setReagent('oto'); setUse('drinking');
    document.getElementById('siteName').value = 'Live deploy check'; });
  const input = await p.$('#photoInput');
  await input.uploadFile(path.join(__dirname, 'samples', 'oto_0p6.png'));
  await p.waitForFunction(() => window.lastReading !== null, { timeout: 15000 });

  const r = await p.evaluate(() => ({
    conc: window.lastReading.conc, species: window.lastReading.species,
    result: document.getElementById('clResult').innerText.replace(/\n/g, ' | '),
    caution: document.getElementById('otoCaution').innerText.slice(0, 90),
    sw: !!navigator.serviceWorker.controller || navigator.serviceWorker.getRegistrations !== undefined,
    pdfOK: (() => { try { return AquasafePDF.build(buildReportDoc()).size > 5000; } catch (e) { return 'ERR ' + e.message; } })(),
  }));
  console.log('URL       ', URL);
  console.log('reading   ', r.conc.toFixed(3), 'mg/L  species=' + r.species);
  console.log('displayed ', r.result);
  console.log('caveat    ', r.caution.replace(/\s+/g, ' '));
  console.log('PDF builds', r.pdfOK);
  console.log('SW avail  ', r.sw);
  console.log(bad.length ? 'PROBLEMS:\n  ' + bad.join('\n  ') : 'no failed requests, no console errors');
  await b.close();
  process.exit(bad.length || r.pdfOK !== true ? 1 : 0);
})();
