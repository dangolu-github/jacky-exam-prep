/* Submission origin (teacher-only evidence). At submit time, records the approximate city of the
   learner's network, a device label, an opaque per-browser device ID and the device time zone, so
   the teacher can judge whether a hand-in came from the learner's usual device and place.
   Nothing here is shown on learner pages, and a failed lookup never blocks or delays a submission
   by more than LOOKUP_MS. Usage: payload.submissionOrigin = await PortalSubmissionOrigin.collect(); */
(function (global) {
  'use strict';
  var STORAGE_KEY = 'portal-submission-device-v1';
  var LOOKUP_MS = 3500;
  var REUSE_MS = 5 * 60 * 1000;
  var PROVIDERS = [
    { name: 'geojs', url: 'https://get.geojs.io/v1/ip/geo.json',
      map: function (j) { return { city: j.city, region: j.region, country: j.country_code, countryName: j.country }; } },
    { name: 'ipwho.is', url: 'https://ipwho.is/?fields=success,city,region,country,country_code',
      map: function (j) { return j.success === false ? null : { city: j.city, region: j.region, country: j.country_code, countryName: j.country }; } },
    { name: 'ipinfo', url: 'https://ipinfo.io/json',
      map: function (j) { return { city: j.city, region: j.region, country: j.country, countryName: '' }; } }
  ];
  var cached = null, cachedAt = 0;

  function clip(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); }

  function deviceId() {
    try {
      var id = global.localStorage.getItem(STORAGE_KEY) || '';
      if (!/^d-[a-f0-9]{16}$/.test(id)) {
        var bytes = new Uint8Array(8);
        global.crypto.getRandomValues(bytes);
        id = 'd-' + Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        global.localStorage.setItem(STORAGE_KEY, id);
      }
      return id;
    } catch (e) { return ''; } // private browsing or storage blocked
  }

  function deviceLabel(ua, touchPoints) {
    var os = /HarmonyOS|OpenHarmony/.test(ua) ? 'HarmonyOS'
      : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'iPad'
      : /iPhone|iPod/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
      : /Windows/.test(ua) ? 'Windows'
      : /CrOS/.test(ua) ? 'Chromebook'
      : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
      : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
    var browser = /MicroMessenger/i.test(ua) ? 'WeChat'
      : /MQQBrowser|QQBrowser/.test(ua) ? 'QQ Browser'
      : /\bQQ\//.test(ua) ? 'QQ'
      : /UCBrowser/.test(ua) ? 'UC Browser'
      : /Quark\//.test(ua) ? 'Quark'
      : /HuaweiBrowser/.test(ua) ? 'Huawei Browser'
      : /MiuiBrowser/.test(ua) ? 'Xiaomi Browser'
      : /baiduboxapp|BaiduBrowser/i.test(ua) ? 'Baidu'
      : /Edg(A|iOS)?\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os + ' · ' + browser;
  }

  function fetchJson(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, LOOKUP_MS);
    return fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); },
        function (e) { clearTimeout(timer); throw e; });
  }

  // Asks all providers at once and keeps the first usable answer; resolves null when none answers in time.
  function locate() {
    return new Promise(function (resolve) {
      var left = PROVIDERS.length, done = false;
      var timer = setTimeout(function () { finish(null); }, LOOKUP_MS + 200);
      function finish(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }
      PROVIDERS.forEach(function (p) {
        fetchJson(p.url).then(function (j) {
          var g = p.map(j || {});
          if (!g || !(g.city || g.country)) throw Error('empty');
          g.source = p.name;
          finish(g);
        }).catch(function () { if (--left === 0) finish(null); });
      });
    });
  }

  function build(geo) {
    var nav = global.navigator || {};
    var ua = clip(nav.userAgent, 400);
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    return {
      v: 1,
      city: clip(geo && geo.city, 80),
      region: clip(geo && geo.region, 80),
      country: clip(geo && geo.country, 8).toUpperCase(),
      countryName: clip(geo && geo.countryName, 80),
      geoSource: geo ? geo.source : 'unavailable',
      device: deviceLabel(ua, nav.maxTouchPoints || 0),
      deviceId: deviceId(),
      timeZone: clip(tz, 64),
      userAgent: ua
    };
  }

  // Never rejects. Reuses one lookup for a few minutes so repeated saves on one page stay fast.
  function collect() {
    var now = Date.now();
    if (!cached || now - cachedAt > REUSE_MS) {
      cachedAt = now;
      cached = locate().then(build, function () { return build(null); }).catch(function () { return { v: 1, geoSource: 'error' }; });
    }
    return cached;
  }

  global.PortalSubmissionOrigin = { collect: collect, warm: collect, _deviceLabel: deviceLabel };
})(typeof window !== 'undefined' ? window : this);
