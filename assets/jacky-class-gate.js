/* Jacky portal · class page gate.
   A class page is published as `<page>.enc` (12-byte nonce, then AES-256-GCM ciphertext and tag) next to
   this gate page. The key comes only from the course service, and only for a browser holding a valid
   reading-practice sign-in, so this shares the reading page's saved sign-in (same storage keys) and the
   same passphrase. After decrypting, the original page is written into this document at the same URL.
   A ?tp= owner preview opens a test session and never touches the reader's saved sign-in. */
(function (global) {
  'use strict';

  var CONFIG = global.JACKY_READING_CONFIG || {};
  var SERVICE_URL = CONFIG.serviceUrl || '';
  var TOKEN_KEY = 'jacky-reading-token';
  var SCOPE_KEY = 'jacky-reading-scope';
  var AAD_PREFIX = 'jacky-class-v1|';
  var TIMEOUT_MS = 30000;
  var doc = global.document;

  function el(id) { return doc.getElementById(id); }
  function store(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function keep(k, v) { try { global.localStorage.setItem(k, v); } catch (e) { /* storage refused */ } }
  function drop(k) { try { global.localStorage.removeItem(k); } catch (e) { /* nothing kept */ } }
  function say(text, kind) {
    var node = el('gateStatus');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }
  function route() {
    var meta = doc.querySelector('meta[name="jacky-class-route"]');
    return meta ? meta.getAttribute('content') : '';
  }

  // A refusal from the service itself (it answered, and said no) is told apart from no answer at all,
  // so a dropped connection never throws away a saved sign-in.
  function ServiceRefusal(message) { this.message = message; }

  function post(body) {
    if (!/^https:\/\/script\.google\.com\//.test(SERVICE_URL)) return Promise.reject(new Error('暂时连不上课程服务，请稍后再试。'));
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = global.setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    return global.fetch(SERVICE_URL, {
      method: 'POST', credentials: 'omit', signal: controller ? controller.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
    }).then(function (r) { global.clearTimeout(timer); return r.text(); },
      function () { global.clearTimeout(timer); throw new Error('暂时连不上课程服务，请稍后再试。'); })
      .then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (!json) throw new Error('暂时连不上课程服务，请稍后再试。');
        if (!json.ok) throw new ServiceRefusal(json.error || '');
        return json;
      });
  }

  function bytesFromBase64url(text) {
    var b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = global.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function openPage(token) {
    var here = route();
    var encUrl = String(global.location.pathname).replace(/[^/]*$/, '') + here.split('/').pop().replace(/\.html$/, '.enc');
    say('正在打开…');
    return Promise.all([
      post({ action: 'readingClassKey', token: token }),
      global.fetch(encUrl, { cache: 'no-cache', credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('这一页暂时打不开，请稍后再试。');
        return r.arrayBuffer();
      })
    ]).then(function (both) {
      var payload = new Uint8Array(both[1]);
      var subtle = global.crypto && global.crypto.subtle;
      if (!subtle) throw new Error('这个浏览器打不开这一页，请换用 Chrome、Safari 或 Edge。');
      return subtle.importKey('raw', bytesFromBase64url(both[0].contentKey), { name: 'AES-GCM' }, false, ['decrypt'])
        .then(function (key) {
          return subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12),
            additionalData: new TextEncoder().encode(AAD_PREFIX + here), tagLength: 128 }, key, payload.subarray(12));
        });
    }).then(function (plain) {
      var html = new TextDecoder('utf-8').decode(plain);
      doc.open();
      doc.write(html);
      doc.close();
    });
  }

  function fail(error, savedToken) {
    if (error instanceof ServiceRefusal) {
      if (savedToken) { drop(TOKEN_KEY); drop(SCOPE_KEY); say('请重新登录。'); return; }
      say(/Too many/.test(error.message) ? '尝试次数太多，请稍后再试。' : '登录没有成功，请检查密码。', 'error');
      return;
    }
    say((error && error.message) || '这一页暂时打不开，请稍后再试。', 'error');
  }

  function previewRequest() {
    var places = [String(global.location.search || ''), String(global.location.hash || '')];
    for (var i = 0; i < places.length; i += 1) {
      var found = /[?&]tp(?:=([^&#]*))?(?=[&#]|$)/.exec(places[i]);
      if (!found) continue;
      var raw = found[1] == null ? '' : found[1];
      try { return { present: true, proof: decodeURIComponent(raw) }; } catch (e) { return { present: true, proof: raw }; }
    }
    return { present: false, proof: '' };
  }

  function signIn(passphrase) {
    var button = el('signInBtn');
    button.disabled = true;
    say('…');
    return post({ action: 'readingAuthenticate', passphrase: passphrase }).then(function (result) {
      keep(TOKEN_KEY, result.token);
      if (/^[a-f0-9]{16}$/.test(String(result.storageScope || ''))) keep(SCOPE_KEY, result.storageScope);
      return openPage(result.token);
    }).catch(function (error) {
      button.disabled = false;
      fail(error, '');
    });
  }

  function init() {
    el('signInForm').addEventListener('submit', function (event) {
      event.preventDefault();
      signIn(el('passphrase').value);
    });
    var asked = previewRequest();
    if (asked.present) {
      if (!asked.proof) { say('这个预览链接打不开了。', 'error'); return; }
      say('…');
      post({ action: 'readingAuthenticate', previewToken: asked.proof }).then(function (result) {
        return openPage(result.token);                 // a preview token is never saved on this device
      }).catch(function (error) { say((error && error.message) || '这个预览链接打不开了。', 'error'); });
      return;
    }
    var saved = store(TOKEN_KEY) || '';
    var m = /^v1\.[a-z]+\.(\d{10})\.[a-f0-9]{40}$/.exec(saved);
    if (m && Number(m[1]) > Date.now() / 1000) {
      openPage(saved).catch(function (error) { fail(error, saved); });
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
