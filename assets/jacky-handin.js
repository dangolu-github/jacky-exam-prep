/* Jacky hand-in helper. Sends a finished practice set to the course service and waits for its receipt.
   If the service cannot be reached, the same work goes through the earlier form, so nothing is lost.
   The learner page shows only "Submitted" or a retry message. */
(function (global) {
  'use strict';
  var SERVICE_URL = 'https://script.google.com/macros/s/AKfycbyv4devEV2UwbOx-wXIvEMcXDSnyeX6gAOAeZCvP6yugz5f-xUGxOcTQDipq-WUSSk-/exec';
  var REQUEST_PREFIX = 'jacky-handin-request:';
  var TIMEOUT_MS = 25000;
  var current = global.document && global.document.currentScript;
  var base = current && current.src ? current.src.replace(/[^/]*$/, '') : '';
  var originLoading = null;

  function previewToken() {
    var m = /[?&]tp=(\d{10}\.[a-f0-9]{40})(?:&|$)/.exec(global.location.search || '');
    try {
      if (m) global.sessionStorage.setItem('jacky-tp', m[1]);
      return m ? m[1] : (global.sessionStorage.getItem('jacky-tp') || '');
    } catch (e) { return m ? m[1] : ''; }
  }

  function loadOrigin() {
    if (global.PortalSubmissionOrigin) return Promise.resolve();
    if (!originLoading) {
      originLoading = new Promise(function (resolve) {
        var s = global.document.createElement('script');
        s.src = base + 'submission-origin.js?v=20261013';
        s.onload = resolve; s.onerror = resolve;
        global.document.head.appendChild(s);
      });
    }
    return originLoading;
  }

  function collectOrigin() {
    return loadOrigin().then(function () {
      return global.PortalSubmissionOrigin ? global.PortalSubmissionOrigin.collect() : {};
    }).catch(function () { return {}; });
  }

  function randomId() {
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // One request ID per unfinished hand-in, kept until it is confirmed, so a retry is never stored twice.
  function requestId(key) {
    try {
      var saved = global.localStorage.getItem(REQUEST_PREFIX + key);
      if (/^[a-f0-9]{32}$/.test(saved || '')) return saved;
      var id = randomId();
      global.localStorage.setItem(REQUEST_PREFIX + key, id);
      return id;
    } catch (e) { return randomId(); }
  }
  function forget(key) { try { global.localStorage.removeItem(REQUEST_PREFIX + key); } catch (e) { /* nothing kept */ } }

  function timedFetch(url, options) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return global.fetch(url, Object.assign({ credentials: 'omit', signal: ctrl ? ctrl.signal : undefined }, options))
      .then(function (r) { clearTimeout(timer); return r.text(); }, function (e) { clearTimeout(timer); throw e; })
      .then(function (text) { try { return JSON.parse(text); } catch (e) { return null; } });
  }

  function confirmReceipt(id) {
    return timedFetch(SERVICE_URL + '?action=getReceipt&requestId=' + encodeURIComponent(id), { method: 'GET' })
      .then(function (j) { return j && j.ok && j.found && j.result && j.result.receiptId ? j.result : null; })
      .catch(function () { return null; });
  }

  // opts: key, assignmentId, studentName, answers {itemId: value}, notes {itemId: value},
  //       legacyText (the earlier form's answer text), legacySubmit(text) -> Promise.
  function send(opts) {
    var id = requestId(opts.key);
    var token = previewToken();
    return collectOrigin().then(function (origin) {
      var body = {
        action: 'submit', requestId: id, assignmentId: opts.assignmentId, studentName: opts.studentName || 'Jacky',
        answers: opts.answers || {}, notes: opts.notes || {}, clientTime: new Date().toISOString(),
        page: global.location.pathname + global.location.hash, previewToken: token, submissionOrigin: origin || {}
      };
      var toService = /^https:\/\/script\.google\.com\//.test(SERVICE_URL)
        ? timedFetch(SERVICE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
            .catch(function () { return null; })
            .then(function (j) { return j && j.ok && j.receiptId ? j : confirmReceipt(id); })
        : Promise.resolve(null);
      return toService.then(function (receipt) {
        if (receipt && receipt.receiptId) { forget(opts.key); return { ok: true, via: 'portal', receiptId: receipt.receiptId }; }
        var lines = ['', 'Request: ' + id, 'Submission origin: ' + JSON.stringify(origin || {})];
        if (token) lines.push('Preview: test');
        return opts.legacySubmit(opts.legacyText + '\n' + lines.join('\n')).then(function () {
          forget(opts.key);
          return { ok: true, via: 'form' };
        });
      });
    });
  }

  function showPreviewNote() {
    if (!previewToken() || global.document.getElementById('jackyPreviewNote')) return;
    var note = global.document.createElement('div');
    note.id = 'jackyPreviewNote';
    note.setAttribute('role', 'note');
    note.textContent = 'Teacher preview: hand-ins from this page are saved as tests.';
    note.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99;max-width:calc(100% - 24px);padding:8px 12px;border-radius:10px;background:#faf0d9;color:#84570f;font:700 13px/1.4 Arial,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.15)';
    global.document.body.appendChild(note);
  }

  // The location lookup starts once the learner begins answering, not on every page view.
  function warmOnFirstAnswer() {
    var started = false;
    function start() { if (started) return; started = true; collectOrigin(); }
    global.document.addEventListener('input', start, { once: true });
    global.document.addEventListener('change', start, { once: true });
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', showPreviewNote);
    else showPreviewNote();
    warmOnFirstAnswer();
  }
  global.JackyHandin = { send: send, isPreview: function () { return Boolean(previewToken()); } };
})(window);
