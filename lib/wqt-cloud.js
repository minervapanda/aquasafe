// wqt-cloud.js — accounts + cloud copy of saved tests, shared by Aquasafe and PoolCheck.
//
// The phone's existing test log (localStorage) stays the source of truth on the device. Each
// saved test gets a client UUID and a `sync` state written INTO its log entry; this file uploads
// entries whose state is 'pending' and marks them 'done'. Only the stamped photo lives in
// IndexedDB, keyed by the same UUID. So if the browser evicts IndexedDB (iOS does after 7 days
// unused), a pending test's NUMBER still uploads; only its photo is lost, and that is recorded.
//
//   wqtCloud.init({ app, kind, logKey, version, mount })   once, after the page loads
//   wqtCloud.stamp(rec, canvasOrNull)                       inside saveReading(), before the log is written
//   wqtCloud.badge(rec)                                     tiny HTML marker for the history table
//
// Security notes: the anon key below is public by design (it only identifies the project);
// every row is guarded by row-level security in the database, keyed on the signed-in user.
// Admin accounts are refused here — they sign in on the admin page, whose session lives in
// sessionStorage, so an admin token never sits in this origin's shared localStorage.
(function () {
  'use strict';

  var CFG = {
    url: 'https://frxlazufoztmabdkmdcl.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyeGxhenVmb3p0bWFiZGttZGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTc0MDUsImV4cCI6MjEwNDAzMzQwNX0.fiYdgoc7HXcHhkrrFUoEoajf9vyonR0G4BdlcWRuVdw',
    userDomain: 'users.wqt.invalid',
    adminPage: 'https://minervapanda.github.io/water-quality-tools/admin/',
    photoMaxW: 960,
    photoQuality: 0.8,
    drainEveryMs: 5 * 60 * 1000
  };

  var opts = null, sb = null, session = null, profile = null;
  var state = { pending: 0, dead: 0, lastSync: null, problem: null, busy: false };
  var USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

  // ── small helpers ────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); });
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function normUser(s) { return String(s || '').trim().toLowerCase(); }
  function toEmail(id) { id = normUser(id); return id.indexOf('@') >= 0 ? id : id + '@' + CFG.userDomain; }
  function emit() {
    try { window.dispatchEvent(new CustomEvent('wqt-cloud-status', { detail: status() })); } catch (e) { }
    render();
  }
  function status() {
    return { signedIn: !!profile, username: profile && profile.username, displayName: profile && profile.display_name,
      pending: state.pending, dead: state.dead, lastSync: state.lastSync, problem: state.problem };
  }

  // ── the on-phone log (owned by the app; we only add sync fields) ───────────
  var SYNC_FIELDS = ['sync', 'syncUser', 'syncError', 'syncedAt', 'photo', 'photoTries', 'syncTries', 'savedAt'];
  function readLog() { try { return JSON.parse(localStorage.getItem(opts.logKey) || '[]'); } catch (e) { return []; } }
  // Read-modify-write with no await in between, so a save in this tab cannot interleave.
  function patchLog(id, fields) {
    var log = readLog(), hit = false;
    for (var i = 0; i < log.length; i++) if (log[i].id === id) { Object.assign(log[i], fields); hit = true; }
    if (hit) try { localStorage.setItem(opts.logKey, JSON.stringify(log)); } catch (e) { }
    return hit;
  }
  function recount() {
    var uid = session && session.user && session.user.id, p = 0, d = 0, o = 0;
    readLog().forEach(function (r) {
      if (r.sync === 'pending' && uid && r.syncUser !== uid) o++;
      else if (r.sync === 'pending') p++;
      if (r.sync === 'dead' && (!uid || r.syncUser === uid)) d++;
    });
    state.pending = p; state.dead = d; state.others = o;
  }

  // ── IndexedDB: photos only ─────────────────────────────────────────────────
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no IndexedDB'));
      var q = indexedDB.open('wqt_cloud', 1);
      q.onupgradeneeded = function () { q.result.createObjectStore('photos', { keyPath: 'id' }); };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
    return dbp;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('photos', mode), s = t.objectStore('photos'), out = fn(s);
        t.oncomplete = function () { res(out && out.result); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  function putPhoto(rec) { return idb('readwrite', function (s) { return s.put(rec); }); }
  // Safari can leave indexedDB.open hanging; never let that wedge the upload queue.
  function within(ms, p) { return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]); }
  function getPhoto(id) { return within(10000, idb('readonly', function (s) { return s.get(id); })); }
  function delPhoto(id) { return idb('readwrite', function (s) { return s.delete(id); }); }

  function snapshot(canvas) {
    // Copy and downscale now: the app redraws its stamp canvas when the address arrives and on
    // the next capture, and the stored photo must be the one this test was saved with.
    return new Promise(function (res) {
      try {
        var sc = Math.min(1, CFG.photoMaxW / canvas.width), c = document.createElement('canvas');
        c.width = Math.round(canvas.width * sc); c.height = Math.round(canvas.height * sc);
        c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
        c.toBlob(function (b) { res(b && b.type === 'image/jpeg' ? b : null); }, 'image/jpeg', CFG.photoQuality);
      } catch (e) { res(null); }      // a tainted canvas (map tile without CORS) cannot be exported
    });
  }
  function sha256(blob) {
    return blob.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); })
      .then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); });
  }

  // ── save hook ───────────────────────────────────────────────────────────────
  // Called by the app with the record it is about to push into its log. Synchronous on purpose:
  // the sync fields must be on the record before the app writes the log.
  function stamp(rec, canvas) {
    if (!opts || !rec) return;
    if (!rec.id) rec.id = uuid();
    if (rec.sync === 'done' || rec.sync === 'pending') return;      // a second tap on Save
    var uid = profile && session && session.user && session.user.id;
    if (!uid) { rec.sync = 'local'; return; }
    rec.sync = 'pending'; rec.syncUser = uid; rec.savedAt = Date.now();
    if (canvas && !rec.manual) {
      rec.photo = 'pending';
      snapshot(canvas).then(function (blob) {
        if (!blob) { patchLog(rec.id, { photo: 'none' }); return; }
        return sha256(blob).then(function (h) { return putPhoto({ id: rec.id, blob: blob, sha256: h, at: Date.now() }); });
      }).catch(function () { patchLog(rec.id, { photo: 'none' }); })
        .then(function () { recount(); emit(); drain(); });
    } else {
      rec.photo = 'none';
      setTimeout(function () { recount(); emit(); drain(); }, 0);
    }
  }

  function badge(rec) {
    if (!rec || !rec.sync || rec.sync === 'local') return '';
    var m = { pending: ['⏳', 'Waiting to upload'], done: ['☁︎', 'Uploaded to your account'], dead: ['⚠', 'Kept on this phone — the server refused it: ' + (rec.syncError || '')] }[rec.sync];
    if (!m) return '';
    return '<span class="wqt-b wqt-b-' + rec.sync + '" title="' + m[1].replace(/"/g, '&quot;').replace(/</g, '&lt;') + '">' + m[0] + '</span> ';
  }

  // ── upload ──────────────────────────────────────────────────────────────────
  function classify(err, status) {
    var code = err && (err.code || err.statusCode), msg = String((err && (err.message || err.error)) || '');
    // supabase-js 2.45 storage errors carry .status (a number); PostgREST errors come with r.status.
    status = status || (err && (+err.status || +err.statusCode)) || 0;
    if (err && err.name === 'AuthRetryableFetchError') return 'offline';
    if (!navigator.onLine || /Failed to fetch|NetworkError|Load failed|network/i.test(msg) || status === 0) return 'offline';
    if (status === 401 || /JWT|token/i.test(msg)) return 'auth';
    if (code === '42501' || status === 403 || /row-level security|violates row-level/i.test(msg)) return 'denied';
    if (status === 429 || status >= 500 || status === 404 || status === 408 || status === 409) return 'later';
    return 'reject';
  }
  var backoff = 0, timer = null;
  function later(ms) { clearTimeout(timer); timer = setTimeout(drain, ms); }

  function rowFor(rec) {
    var body = {};
    Object.keys(rec).forEach(function (k) { if (SYNC_FIELDS.indexOf(k) < 0) body[k] = rec[k]; });
    var t = new Date(rec.ts);
    return {
      id: rec.id, tenant_id: profile.tenant_id, user_id: rec.syncUser, kind: opts.kind, app: opts.app,
      captured_at: isFinite(t) ? t.toISOString() : new Date().toISOString(),   // body.ts keeps the original
      lat: (typeof rec.lat === 'number' && isFinite(rec.lat)) ? rec.lat : null,
      lon: (typeof rec.lon === 'number' && isFinite(rec.lon)) ? rec.lon : null,
      body: body, app_version: opts.version
    };
  }

  function uploadOne(rec) {
    return Promise.resolve(rec.photo === 'pending' ? getPhoto(rec.id).catch(function () { return null; }) : null)
      .then(function (ph) {
        if (rec.photo === 'pending' && !ph) {
          // Photo blob still being written by a save a moment ago, or evicted by the browser.
          // Measured from the SAVE, not the capture: a test read at 10:00 and saved at 10:03 still
          // has its photo being written.
          var age = Date.now() - (rec.savedAt || new Date(rec.ts).getTime());
          if (age < 2 * 60 * 1000) return { wait: true };
          rec.photo = 'lost'; patchLog(rec.id, { photo: 'lost' });
        }
        var row = rowFor(rec);
        if (ph) row.body.photo_sha256 = ph.sha256;
        if (!isFinite(new Date(rec.ts))) row.body.ts_invalid = true;
        if (rec.photo === 'lost') row.body.photo_lost = true;
        return sb.from('readings').upsert(row, { onConflict: 'id', ignoreDuplicates: true }).then(function (r) {
          if (r.error) return { fail: classify(r.error, r.status), error: r.error };
          if (!ph) return { ok: true };
          var key = profile.tenant_id + '/' + rec.id + '.jpg';
          return sb.storage.from('photos').upload(key, ph.blob, { contentType: 'image/jpeg', upsert: true }).then(function (u) {
            if (u.error) return { fail: classify(u.error, u.error.status), error: u.error, photo: true, rowDone: true };
            return sb.from('readings').update({ photo_path: key }).eq('id', rec.id).then(function (p) {
              if (p.error) return { fail: classify(p.error, p.status), error: p.error, photo: true, rowDone: true };
              return delPhoto(rec.id).catch(function () { }).then(function () { return { ok: true, photo: true }; });
            });
          });
        });
      });
  }

  function drainOnce() {
    if (!sb || !profile || !navigator.onLine) return Promise.resolve();
    var uid = session.user.id;
    var todo = readLog().filter(function (r) { return r.sync === 'pending' && r.syncUser === uid && r.id; });
    if (!todo.length) { recount(); state.problem = null; emit(); return Promise.resolve(); }
    state.busy = true; emit();
    // getSession refreshes an expired access token before we use it (needs the network).
    return sb.auth.getSession().then(function (s) {
      if (s.error && classify(s.error) === 'offline') { state.problem = 'offline'; backoff = Math.min(backoff ? backoff * 2 : 15000, 600000); later(backoff); return; }
      if (!s.data.session) { state.problem = 'auth'; return; }
      session = s.data.session;
      var i = 0;
      function next() {
        if (i >= todo.length) { state.problem = null; backoff = 0; state.lastSync = new Date(); sb.rpc('touch_last_seen').then(function () { }, function () { }); return; }
        var rec = todo[i++];
        return uploadOne(rec).then(function (res) {
          if (res.wait) { later(5000); return next(); }        // photo still being written: look again shortly
          if (res.ok) { patchLog(rec.id, { sync: 'done', syncedAt: new Date().toISOString(), syncError: null, photo: res.photo ? 'done' : rec.photo }); return next(); }
          var why = String(res.error && res.error.message || res.fail).slice(0, 200);
          // The numbers are already in the account. A photo the server refuses (too large, account
          // over its photo cap) must not hold the record — or every test queued after it — hostage.
          if (res.rowDone && (res.fail === 'reject' || (res.fail !== 'offline' && (rec.photoTries || 0) >= 2))) {
            delPhoto(rec.id).catch(function () { });
            patchLog(rec.id, { sync: 'done', syncedAt: new Date().toISOString(), photo: 'failed', syncError: 'photo not uploaded: ' + why });
            return next();
          }
          if (res.rowDone && res.fail !== 'offline') patchLog(rec.id, { photoTries: (rec.photoTries || 0) + 1 });
          // A 4xx can be momentary (the server reloading its schema after an update), so a test is
          // only given up on after three refusals on separate attempts.
          if (res.fail === 'reject') {
            var tries = (rec.syncTries || 0) + 1;
            patchLog(rec.id, tries >= 3 ? { sync: 'dead', syncError: why, syncTries: tries } : { syncTries: tries, syncError: why });
            return next();
          }
          state.problem = res.fail;                       // offline / auth / denied / later: stop, keep queue
          backoff = Math.min(backoff ? backoff * 2 : 15000, 10 * 60 * 1000);
          if (res.fail !== 'denied') later(backoff);
        });
      }
      return next();
    }).catch(function () { state.problem = 'offline'; })
      .then(function () { state.busy = false; recount(); emit(); });
  }

  var draining = null, drainAgain = false;
  function drain() {
    // A request that arrives while an upload pass is running (a second Save, a photo that just
    // finished writing) must not be dropped: run one more pass when this one ends.
    if (draining) { drainAgain = true; return draining; }
    // One drain per origin at a time: Aquasafe and PoolCheck share this origin, session and
    // IndexedDB, and two tabs uploading the same photo on 2G wastes the link.
    var run = function () { return drainOnce(); };
    draining = (navigator.locks && navigator.locks.request
      ? navigator.locks.request('wqt-drain-' + opts.app, { ifAvailable: true }, function (lock) { return lock ? run() : null; })
      : run()).then(function () { draining = null; }, function () { draining = null; })
      .then(function () { if (drainAgain) { drainAgain = false; drain(); } });
    return draining;
  }

  // ── backfill: tests saved on this phone before signing in ──────────────────
  function backfillable() {
    return readLog().filter(function (r) { return !r.sync || r.sync === 'local'; });
  }
  function backfill() {
    var uid = session.user.id, log = readLog(), n = 0;
    log.forEach(function (r) {
      if (!r.sync || r.sync === 'local') {
        if (!r.id) r.id = uuid();
        r.sync = 'pending'; r.syncUser = uid; r.photo = 'none'; r.backfilled = true; n++;
      }
    });
    try { localStorage.setItem(opts.logKey, JSON.stringify(log)); } catch (e) { }
    recount(); emit(); drain();
    if (typeof opts.onLogChanged === 'function') opts.onLogChanged();
    return n;
  }

  // ── auth ────────────────────────────────────────────────────────────────────
  function loadProfile() {
    if (!session) { profile = null; return Promise.resolve(null); }
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('wqt-profile') || 'null'); } catch (e) { }
    if (cached && cached.user_id === session.user.id) profile = cached;
    if (!navigator.onLine && profile) return Promise.resolve(profile);
    return sb.from('profiles').select('user_id, tenant_id, role, username, display_name, active')
      .eq('user_id', session.user.id).maybeSingle().then(function (r) {
        if (r.error) { if (classify(r.error, r.status) === 'offline') return profile; throw r.error; }
        if (!r.data) { profile = null; return null; }
        profile = r.data;
        try { localStorage.setItem('wqt-profile', JSON.stringify(profile)); } catch (e) { }
        return profile;
      });
  }
  function afterSignIn() {
    return loadProfile().then(function (p) {
      if (p && p.role === 'admin') {
        return sb.auth.signOut({ scope: 'local' }).then(function () {
          session = null; profile = null;
          throw new Error('ADMIN_HERE');
        });
      }
      if (p && !p.active) state.problem = 'denied';
      // "Tested by" follows the account: fill it when empty, and replace it when it still holds
      // the previous account's name (a shared phone), so B's tests never carry A's name.
      var op = $('operator'), prev = null;
      try { prev = localStorage.getItem('wqt-last-name'); } catch (e) { }
      if (p && op && (!op.value || (prev && op.value === prev && prev !== p.display_name))) {
        op.value = p.display_name;
        try { localStorage.setItem('aquasafe_operator', p.display_name); op.dispatchEvent(new Event('input')); } catch (e) { }
      }
      try { if (p) localStorage.setItem('wqt-last-name', p.display_name); } catch (e) { }
      recount(); emit(); drain();
      return p;
    });
  }
  function friendly(err) {
    var m = String((err && err.message) || err || '');
    if (m === 'ADMIN_HERE') return 'This is an admin account. Admins sign in on the admin page, not in the field app.';
    if (/already registered|already been registered|duplicate key/i.test(m)) return 'That username is taken. Pick another one.';
    if (/Invalid login credentials/i.test(m)) return 'Username or password is wrong.';
    if (/banned/i.test(m)) return 'This account has been switched off by your admin.';
    if (/Password should be|at least 8|weak/i.test(m)) return 'The password must be at least 8 characters.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a few minutes and try again.';
    if (!navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No internet. Signing in needs a connection once; after that tests save offline and upload later.';
    if (/Database error saving new user/i.test(m)) return 'That username is not allowed. Use 3–30 letters, digits, dot, dash or underscore.';
    return 'Something went wrong: ' + m.slice(0, 120);
  }

  function signIn(id, pw) {
    return sb.auth.signInWithPassword({ email: toEmail(id), password: pw }).then(function (r) {
      if (r.error) throw r.error;
      session = r.data.session;
      return afterSignIn();
    });
  }
  function signUp(username, displayName, pw) {
    username = normUser(username);
    if (!USERNAME_RE.test(username)) return Promise.reject(new Error('Database error saving new user'));
    return sb.auth.signUp({ email: toEmail(username), password: pw, options: { data: { display_name: displayName.trim() } } })
      .then(function (r) {
        if (r.error) throw r.error;
        // Supabase answers a sign-up for an existing address with a user but no session (it does
        // not reveal which addresses exist); here that can only mean the username is taken.
        if (!r.data.session) throw new Error('already registered');
        session = r.data.session;
        return afterSignIn();
      });
  }
  function signOut() {
    recount();
    var who = profile ? profile.username : '';
    if (state.pending > 0) {
      var go = window.confirm(state.pending + ' test(s) are not uploaded yet. They stay on this phone and upload the next time ' +
        who + ' signs in here. Sign out anyway?');
      if (!go) return Promise.resolve(false);
    }
    return sb.auth.signOut({ scope: 'local' }).then(function () {
      session = null; profile = null; state.problem = null;
      try { localStorage.removeItem('wqt-profile'); } catch (e) { }
      recount(); emit(); return true;
    });
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  var CSS = '.wqt-bar{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fff;border:1px solid #d6deea;' +
    'border-radius:12px;padding:10px 12px;margin:10px 0;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;color:#1c2733}' +
    '.wqt-bar b{color:#08519c}.wqt-bar .wqt-msg{flex:1 1 220px}.wqt-bar button,.wqt-card button{font:inherit;border-radius:8px;border:1px solid #08519c;' +
    'background:#08519c;color:#fff;padding:6px 12px;cursor:pointer}.wqt-bar button.sec,.wqt-card button.sec{background:#fff;color:#08519c}' +
    '.wqt-warn{color:#8a4b00}.wqt-bad{color:#b00020}.wqt-ok{color:#1b7a3a}' +
    '.wqt-ov{position:fixed;inset:0;background:rgba(10,25,40,.55);display:flex;align-items:flex-start;justify-content:center;z-index:9999;overflow:auto;padding:24px 12px}' +
    '.wqt-card{background:#fff;border-radius:14px;max-width:400px;width:100%;padding:18px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1c2733}' +
    '.wqt-card h3{margin:0 0 10px;font-size:18px}.wqt-card label{display:block;font-size:12.5px;color:#456;margin:10px 0 3px}' +
    '.wqt-card input[type=text],.wqt-card input[type=password]{width:100%;box-sizing:border-box;font:inherit;padding:9px;border:1px solid #c6d0de;border-radius:8px}' +
    '.wqt-tabs{display:flex;gap:6px;margin-bottom:6px}.wqt-tabs button{flex:1}.wqt-err{color:#b00020;font-size:13px;min-height:1em;margin-top:8px}' +
    '.wqt-note{font-size:12px;color:#557;margin-top:10px}.wqt-row{display:flex;gap:8px;margin-top:14px}.wqt-row button{flex:1}' +
    '.wqt-b{font-size:12px}.wqt-b-dead{color:#b00020}.wqt-b-done{color:#1b7a3a}';

  function render() {
    var m = opts && opts.mount && $(opts.mount);
    if (!m) return;
    m.className = 'wqt-bar';
    m.textContent = '';
    if (!profile) {
      m.appendChild(el('span', { 'class': 'wqt-msg', text: 'Tests are saved on this phone only. Sign in to keep a copy in your account.' }));
      m.appendChild(el('button', { type: 'button', text: 'Sign in / Create account', on: { click: function () { openCard('in'); } } }));
      return;
    }
    var msg = el('span', { 'class': 'wqt-msg' }, ['Signed in as ', el('b', { text: profile.display_name }), ' (' + profile.username + ') · ']);
    var p = state.problem;
    if (p === 'denied') msg.appendChild(el('span', { 'class': 'wqt-bad', text: 'Your account is switched off. Ask your admin. Tests stay on this phone.' }));
    else if (p === 'auth') msg.appendChild(el('span', { 'class': 'wqt-warn', text: 'Sign in again to upload ' + state.pending + ' test(s).' }));
    else if (state.pending) msg.appendChild(el('span', { 'class': 'wqt-warn', text: '⏳ ' + state.pending + ' waiting to upload' + (p === 'offline' || !navigator.onLine ? ' (no internet — will retry)' : state.busy ? ' (uploading…)' : '') }));
    else msg.appendChild(el('span', { 'class': 'wqt-ok', text: '☁︎ All tests uploaded' }));
    if (state.dead) msg.appendChild(el('span', { 'class': 'wqt-bad', text: ' · ⚠ ' + state.dead + ' refused by the server (kept on this phone — export the CSV)' }));
    if (state.others) msg.appendChild(el('span', { 'class': 'wqt-warn', text: ' · ' + state.others + ' test(s) by another account are waiting on this phone; they upload when that person signs in here' }));
    m.appendChild(msg);
    var bf = backfillable().length;
    if (bf && p !== 'denied') m.appendChild(el('button', { type: 'button', 'class': 'sec', text: 'Upload ' + bf + ' earlier test(s)', on: { click: function () {
      if (window.confirm('Upload ' + bf + ' test(s) saved on this phone before you signed in? They will be filed under ' + profile.username +
        '. Only do this if you did these tests. Their photos are not on the phone any more, so they upload without one.')) backfill();
    } } }));
    if (p === 'auth') m.appendChild(el('button', { type: 'button', text: 'Sign in again', on: { click: function () { openCard('in'); } } }));
    m.appendChild(el('button', { type: 'button', 'class': 'sec', text: 'Sign out', on: { click: signOut } }));
  }

  function openCard(tab) {
    var ov = el('div', { 'class': 'wqt-ov', role: 'dialog', 'aria-modal': 'true' });
    var card = el('div', { 'class': 'wqt-card' });
    ov.appendChild(card);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    function input(id, type, extra) {
      var i = el('input', Object.assign({ id: id, type: type, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' }, extra || {}));
      return i;
    }
    function draw(which) {
      card.textContent = '';
      card.appendChild(el('h3', { text: which === 'in' ? 'Sign in' : 'Create an account' }));
      var tabs = el('div', { 'class': 'wqt-tabs' }, [
        el('button', { type: 'button', 'class': which === 'in' ? '' : 'sec', text: 'Sign in', on: { click: function () { draw('in'); } } }),
        el('button', { type: 'button', 'class': which === 'up' ? '' : 'sec', text: 'Create account', on: { click: function () { draw('up'); } } })]);
      card.appendChild(tabs);
      var err = el('div', { 'class': 'wqt-err', 'aria-live': 'polite' });
      var u = input('wqt-u', 'text', { autocomplete: 'username', maxlength: '30', placeholder: 'e.g. ravi.k' });
      var pw = input('wqt-p', 'password', { autocomplete: which === 'in' ? 'current-password' : 'new-password', maxlength: '72' });
      card.appendChild(el('label', { 'for': 'wqt-u', text: 'Username' })); card.appendChild(u);
      var dn = null, pw2 = null, consent = null;
      if (which === 'up') {
        dn = input('wqt-d', 'text', { maxlength: '80', autocapitalize: 'words', placeholder: 'As it should appear on test records' });
        card.appendChild(el('label', { 'for': 'wqt-d', text: 'Your full name' })); card.appendChild(dn);
      }
      card.appendChild(el('label', { 'for': 'wqt-p', text: 'Password (at least 8 characters)' })); card.appendChild(pw);
      if (which === 'up') {
        pw2 = input('wqt-p2', 'password', { autocomplete: 'new-password', maxlength: '72' });
        card.appendChild(el('label', { 'for': 'wqt-p2', text: 'Password again' })); card.appendChild(pw2);
        consent = el('input', { type: 'checkbox', id: 'wqt-c' });
        card.appendChild(el('label', { 'for': 'wqt-c', style: 'display:flex;gap:8px;align-items:flex-start;color:#1c2733;font-size:12.5px' }, [consent,
          el('span', { text: 'I agree that this app stores my username, my name, and every test I save — the reading, time, GPS location and the stamped photo — in my organisation\'s account, where only I and my organisation\'s admins can see them. Records are kept for 3 years and photos for 12 months. To have your account and name erased, ask your admin.' })]));
      }
      card.appendChild(err);
      var go = el('button', { type: 'submit', text: which === 'in' ? 'Sign in' : 'Create account' });
      var cancel = el('button', { type: 'button', 'class': 'sec', text: 'Cancel', on: { click: close } });
      card.appendChild(el('div', { 'class': 'wqt-row' }, [cancel, go]));
      card.appendChild(el('div', { 'class': 'wqt-note', text: which === 'in'
        ? 'Forgot your password? Ask your admin to set a new one for you. There is no email reset.'
        : 'Usernames are 3–30 characters: lowercase letters, digits, dot, dash or underscore. Sign-up needs internet once.' }));
      go.addEventListener('click', function () {
        err.textContent = '';
        var name = normUser(u.value);
        u.value = name;
        if (!name) { err.textContent = 'Enter your username.'; return; }
        if ((pw.value || '').length < 8) { err.textContent = 'The password must be at least 8 characters.'; return; }
        var p;
        if (which === 'up') {
          if (!USERNAME_RE.test(name)) { err.textContent = 'Usernames are 3–30 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.'; return; }
          if (!dn.value.trim()) { err.textContent = 'Enter your full name.'; return; }
          if (pw.value !== pw2.value) { err.textContent = 'The two passwords are different.'; return; }
          if (!consent.checked) { err.textContent = 'Tick the box to agree to how your test records are stored.'; return; }
          p = signUp(name, dn.value, pw.value);
        } else p = signIn(name, pw.value);
        go.disabled = true; go.textContent = 'Please wait…';
        p.then(function () { close(); }, function (e) {
          err.textContent = friendly(e); go.disabled = false; go.textContent = which === 'in' ? 'Sign in' : 'Create account';
        });
      });
      setTimeout(function () { u.focus(); }, 30);
    }
    draw(tab);
    document.body.appendChild(ov);
  }

  // ── init ────────────────────────────────────────────────────────────────────
  function init(o) {
    opts = o;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    if (!window.supabase || !window.supabase.createClient) { render(); return; }
    sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'wqt-auth' }
    });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
    recount(); render();
    sb.auth.getSession().then(function (r) {
      session = r.data.session;
      if (!session) { emit(); return; }
      return afterSignIn().catch(function () { emit(); });
    });
    sb.auth.onAuthStateChange(function (ev, s) {
      if (ev === 'SIGNED_OUT') { session = null; profile = null; emit(); }
      else if (s) session = s;
    });
    window.addEventListener('online', function () { drain(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') drain(); });
    setInterval(function () { if (document.visibilityState === 'visible') drain(); }, CFG.drainEveryMs);
  }

  window.wqtCloud = { init: init, stamp: stamp, badge: badge, status: status, drain: drain, _cfg: CFG };
})();
