/* Jacky hand-in helper. Sends a finished practice set to the course service and waits for its receipt.
   If the service cannot be reached, the same work goes through the earlier form, so nothing is lost.
   After a hand-in the page shows the result the service returns: ✓/✗, the correct answer for a wrong
   item and the score, or that the work is waiting for the teacher. The result is shown again on the
   next visit from this browser, together with the teacher's review once it is published. */
(function (global) {
  'use strict';
  var SERVICE_URL = 'https://script.google.com/macros/s/AKfycbyv4devEV2UwbOx-wXIvEMcXDSnyeX6gAOAeZCvP6yugz5f-xUGxOcTQDipq-WUSSk-/exec';
  var REQUEST_PREFIX = 'jacky-handin-request:';
  var DONE_PREFIX = 'jacky-handin-done:';
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
        if (receipt && receipt.receiptId) {
          forget(opts.key);
          remember(opts.key, { requestId: id, assignmentId: opts.assignmentId, receiptId: receipt.receiptId });
          if (receipt.result) showResult(opts.key, opts.assignmentId, receipt.result);
          else refreshResult(opts.key);
          return { ok: true, via: 'portal', receiptId: receipt.receiptId, result: receipt.result || null };
        }
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

  // ---------- result view ----------
  // The confirmed hand-in is remembered per page key, separately for a teacher preview, so the teacher's
  // test results never show on the learner's own visit in the same browser.
  function doneKey(key) { return DONE_PREFIX + (previewToken() ? 'preview:' : '') + key; }
  function remember(key, record) { try { global.localStorage.setItem(doneKey(key), JSON.stringify(record)); } catch (e) { /* shown for this visit only */ } }
  function recall(key) { try { return JSON.parse(global.localStorage.getItem(doneKey(key)) || 'null'); } catch (e) { return null; } }

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  var MARK = { correct: '✓', incorrect: '✗', partial: '½', waiting: '…' };
  var WORD = { correct: 'Correct', incorrect: 'Not correct', partial: 'Partly correct', waiting: 'Waiting for your teacher' };

  function addStyles() {
    var doc = global.document;
    if (doc.getElementById('jackyResultStyles')) return;
    var style = doc.createElement('style');
    style.id = 'jackyResultStyles';
    style.textContent = '.jacky-result{margin:12px 0 0;padding:12px 14px;border:1px solid #cfd8dc;border-radius:12px;background:#fff;color:#182732;font-size:15px;line-height:1.5;max-width:100%;box-sizing:border-box;flex:1 1 100%;min-width:0}' +
      '.jacky-result h3{margin:0 0 6px;font-size:16px}.jacky-result .jr-score{margin:0 0 8px;font-weight:700}.jacky-result ol{margin:0;padding:0;list-style:none;display:grid;gap:6px}' +
      '.jacky-result li{display:grid;grid-template-columns:2.2em minmax(0,1fr);gap:2px 8px;padding:6px 8px;border-radius:8px;background:#f5f7f8;overflow-wrap:anywhere}' +
      '.jacky-result .jr-mark{font-weight:800;text-align:center}.jacky-result .correct .jr-mark{color:#17603d}.jacky-result .incorrect .jr-mark{color:#9c2f2f}.jacky-result .partial .jr-mark,.jacky-result .waiting .jr-mark{color:#84570f}' +
      '.jacky-result .jr-line{grid-column:2}.jacky-result small{color:#5d6b75}.jacky-result .jr-note{margin:8px 0 0}' +
      '@media print{.jacky-result{break-inside:avoid}}';
    doc.head.appendChild(style);
  }

  function anchorFor(key, assignmentId) {
    var doc = global.document;
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var set = doc.querySelector('[data-assignment="' + String(assignmentId).replace(/"/g, '') + '"]');
    var status = set ? set.querySelector('.submit-status') : doc.getElementById('submitStatus');
    return status ? { parent: status.parentNode, after: status } : null;
  }

  function resultHtml(result) {
    if (!result || result.state !== 'result') {
      return '<h3>Submitted · 已提交</h3><p class="jr-score">' + esc((result && result.message) || 'Submitted. Waiting for your teacher to review.') +
        (result && result.messageZh ? ' ' + esc(result.messageZh) : '') + '</p>';
    }
    var s = result.score || {};
    var rows = (result.items || []).map(function (item) {
      var lines = '<span class="jr-line"><strong>' + esc(item.label || item.id) + '</strong> · ' + esc(WORD[item.status] || '') + '</span>' +
        '<span class="jr-line"><small>Your answer:</small> ' + (item.answer ? esc(item.answer) : '—') + '</span>';
      if (item.correction) lines += '<span class="jr-line"><small>Correct answer:</small> ' + esc(item.correction) + '</span>';
      if (item.comment) lines += '<span class="jr-line"><small>Teacher:</small> ' + esc(item.comment) + '</span>';
      return '<li class="' + esc(item.status) + '"><span class="jr-mark" aria-hidden="true">' + (MARK[item.status] || '') + '</span>' + lines + '</li>';
    }).join('');
    return '<h3>Your result · 你的结果</h3><p class="jr-score">Score ' + esc(s.points) + ' / ' + esc(s.outOf) +
      (s.waiting ? ' · ' + esc(s.waiting) + ' answer' + (s.waiting === 1 ? '' : 's') + ' waiting for your teacher' : '') + '</p>' +
      (result.overall ? '<p class="jr-note"><small>Teacher:</small> ' + esc(result.overall) + '</p>' : '') + '<ol>' + rows + '</ol>';
  }

  // The status line often sits in a flex or grid row beside the button: the result gets a row of its own.
  function fullRow(parent, box) {
    try {
      var cs = global.getComputedStyle ? global.getComputedStyle(parent) : null;
      if (!cs) return;
      if (/flex/.test(cs.display) && cs.flexWrap === 'nowrap') parent.style.flexWrap = 'wrap';
      if (/grid/.test(cs.display)) box.style.gridColumn = '1 / -1';
    } catch (e) { /* layout stays as it is */ }
  }

  function showResult(key, assignmentId, result) {
    if (!global.document) return;
    var at = anchorFor(key, assignmentId);
    if (!at) return;
    addStyles();
    var box = at.parent.querySelector('.jacky-result[data-result-for="' + key + '"]');
    if (!box) {
      box = global.document.createElement('section');
      box.className = 'jacky-result';
      box.setAttribute('data-result-for', key);
      box.setAttribute('aria-live', 'polite');
      at.parent.insertBefore(box, at.after.nextSibling);
      fullRow(at.parent, box);
    }
    box.innerHTML = resultHtml(result);
  }

  // Asks the service for the latest view of a hand-in this browser sent (teacher review included).
  function refreshResult(key) {
    var record = recall(key);
    if (!record || !/^[a-f0-9]{32}$/.test(record.requestId || '')) return Promise.resolve(null);
    return timedFetch(SERVICE_URL + '?action=getResult&requestId=' + encodeURIComponent(record.requestId), { method: 'GET' })
      .then(function (j) {
        if (j && j.ok && j.found && j.result) showResult(key, record.assignmentId, j.result);
        return j;
      }).catch(function () { return null; });
  }

  function refreshAll() {
    var keys = [];
    try {
      var prefix = DONE_PREFIX + (previewToken() ? 'preview:' : '');
      for (var i = 0; i < global.localStorage.length; i += 1) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(prefix) === 0 && k.slice(prefix.length).indexOf('preview:') !== 0) keys.push(k.slice(prefix.length));
      }
    } catch (e) { return; }
    keys.forEach(function (key) { refreshResult(key); });
  }

  if (global.document) {
    var start = function () { showPreviewNote(); refreshAll(); };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
    else start();
    warmOnFirstAnswer();
  }
  global.JackyHandin = { send: send, isPreview: function () { return Boolean(previewToken()); }, refreshResult: refreshResult, showResult: showResult };
})(window);
