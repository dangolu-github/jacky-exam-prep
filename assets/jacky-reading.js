/* Jacky reading practice (STAGED public script).
   The page ships empty: the passage, the prompts and the choices arrive only after a successful
   sign-in, from the private course service. Nothing here ever receives a key, a mark or a result —
   a hand-in is answered with a receipt number only.

   Three rules this file follows carefully:
     1. Answers are written to this device first, then synced. A reply only acknowledges the exact
        version it sent, so work typed while a save was in flight is never marked saved and dropped.
     2. A saved draft from the server and the answers on this device are merged field by field against
        the last acknowledged version. If both sides changed the same field, the reader is asked which
        one to keep — nothing is overwritten silently.
     3. Every local key is namespaced by the opaque storage scope the server issues for the signed-in
        reader, so two different sign-ins in the same browser can never see each other's answers.

   "已保存" means one thing only: the server has acknowledged exactly what is on this screen. Answers
   that exist only on this device — including answers written offline and restored on the next visit —
   say 已保存在本机 and stay scheduled until the server acknowledges them. */
(function (global) {
  'use strict';

  var CONFIG = global.JACKY_READING_CONFIG || {};
  var SERVICE_URL = CONFIG.serviceUrl || '';
  var TOKEN_KEY = 'jacky-reading-token';
  var SCOPE_KEY = 'jacky-reading-scope';
  var TIMEOUT_MS = 30000;
  var SYNC_DELAY = 1200;

  var token = '';
  var scope = '';          // opaque, server-issued; namespaces every local key
  var preview = false;     // an owner preview session: test only, and never written to this device
  var session = 0;         // bumped on sign-out/sign-in so old callbacks and timers are ignored
  var sets = [];           // index, no paper content
  var loaded = {};         // setId -> full set
  var state = {};          // setId -> per-set client state
  var byKey = {};          // link fragment -> the server's own ID for that text
  var activeSet = '';
  var originReady = null;

  // ---------- small helpers ----------

  function el(id) { return global.document.getElementById(id); }
  function esc(text) {
    return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function store(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function keep(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* this device refuses storage */ }
  }
  function drop(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* nothing kept */ }
  }
  function parse(text, fallback) {
    try { return JSON.parse(text); } catch (e) { return fallback; }
  }
  function randomId() {
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function say(node, text, kind) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }
  function same(a, b) {
    return JSON.stringify(a == null ? '' : a) === JSON.stringify(b == null ? '' : b);
  }

  // The service is the course web app. A task-private local fixture may be allowed explicitly, and only
  // from a loopback page, so the published configuration can never be pointed somewhere else.
  function serviceAllowed() {
    if (/^https:\/\/script\.google\.com\//.test(SERVICE_URL)) return true;
    if (CONFIG.allowLocalFixture !== true || !SERVICE_URL) return false;
    var host = global.location && global.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
  }

  // Text/plain POST, so the browser sends no CORS preflight.
  function post(body) {
    if (!serviceAllowed()) {
      return Promise.reject(new Error('This page is not connected to the course service yet.'));
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = global.setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    return global.fetch(SERVICE_URL, {
      method: 'POST', credentials: 'omit', signal: controller ? controller.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
    }).then(function (response) {
      global.clearTimeout(timer);
      return response.text();
    }, function (error) {
      global.clearTimeout(timer);
      throw error;
    }).then(function (text) {
      var json = parse(text, null);
      if (!json) throw new Error('The course service could not be reached.');
      if (!json.ok && json.error) throw new Error(json.error);
      return json;
    });
  }

  // The origin helper is the shared, unchanged course script. It is never used for a QA sign-in or a
  // teacher preview, and the learner page shows nothing about it.
  function collectOrigin() {
    if (!global.PortalSubmissionOrigin) return Promise.resolve({});
    if (!originReady) {
      originReady = Promise.resolve(global.PortalSubmissionOrigin.collect()).catch(function () { return {}; });
    }
    return originReady;
  }

  // ---------- per-reader local storage ----------
  // Every key below carries the opaque scope, so a QA sign-in and the learner's own sign-in in one
  // browser keep entirely separate drafts, revisions, baselines and request IDs.

  function key(kind, setId, attempt) {
    return 'jacky-reading-' + kind + ':' + (scope || 'none') + ':' + setId
      + (attempt === undefined ? '' : ':a' + attempt);
  }
  function localDraft(setId, attempt) { return parse(store(key('draft', setId, attempt)) || '{}', {}) || {}; }
  function saveLocalDraft(setId, attempt, values) { keep(key('draft', setId, attempt), JSON.stringify(values)); }
  function localBase(setId, attempt) { return parse(store(key('base', setId, attempt)) || '{}', {}) || {}; }
  function saveLocalBase(setId, attempt, values) { keep(key('base', setId, attempt), JSON.stringify(values)); }
  function localRev(setId, attempt) { return Number(store(key('rev', setId, attempt)) || 0) || 0; }
  function saveLocalRev(setId, attempt, rev) { keep(key('rev', setId, attempt), String(rev)); }
  function requestId(setId, attempt) {
    var k = key('request', setId, attempt);
    var saved = store(k);
    if (/^[a-f0-9]{32}$/.test(saved || '')) return saved;
    var id = randomId();
    keep(k, id);
    return id;
  }

  function info(setId) { return state[setId]; }

  function blankState(setId) {
    return { attempt: 1, status: 'open', rev: 0, gen: 0, ackedGen: 0, syncing: false, syncTimer: 0,
      submitting: false, receiving: true, released: true, receipt: null, conflicts: {}, setId: setId };
  }

  // ---------- reading and writing the controls ----------

  function readValues(setId) {
    var set = loaded[setId];
    var values = {};
    if (!set) return values;
    set.items.concat(set.extras).forEach(function (item) {
      var node = global.document.querySelector('[data-field="' + item.id + '"]');
      if (!node) return;
      if (item.type === 'multi') {
        var picked = [];
        Array.prototype.forEach.call(node.querySelectorAll('input[type="checkbox"]'), function (box) {
          if (box.checked) picked.push(box.getAttribute('value'));
        });
        values[item.id] = picked;
        return;
      }
      if (item.type === 'choice') {
        var chosen = '';
        Array.prototype.forEach.call(node.querySelectorAll('input[type="radio"]'), function (radio) {
          if (radio.checked) chosen = radio.getAttribute('value');
        });
        values[item.id] = chosen;
        return;
      }
      var field = node.querySelector('.answer');
      values[item.id] = field ? String(field.value || '') : '';
    });
    return values;
  }

  function writeValues(setId, values) {
    var set = loaded[setId];
    if (!set) return;
    set.items.concat(set.extras).forEach(function (item) {
      var node = global.document.querySelector('[data-field="' + item.id + '"]');
      if (!node) return;
      if (!Object.prototype.hasOwnProperty.call(values, item.id)) return;
      var saved = values[item.id];
      if (item.type === 'multi') {
        var picked = Array.isArray(saved) ? saved : [];
        Array.prototype.forEach.call(node.querySelectorAll('input[type="checkbox"]'), function (box) {
          box.checked = picked.indexOf(box.getAttribute('value')) >= 0;
        });
        return;
      }
      if (item.type === 'choice') {
        Array.prototype.forEach.call(node.querySelectorAll('input[type="radio"]'), function (radio) {
          radio.checked = String(saved || '') === radio.getAttribute('value');
        });
        return;
      }
      var field = node.querySelector('.answer');
      if (field) field.value = saved == null ? '' : String(saved);
    });
  }

  function setReadOnly(setId, readOnly) {
    var panel = el('panels').querySelector('[data-set="' + setId + '"]');
    if (!panel) return;
    Array.prototype.forEach.call(panel.querySelectorAll('.answer, .opt input'), function (node) {
      node.disabled = Boolean(readOnly);
    });
    var button = panel.querySelector('[data-submit]');
    if (button) button.disabled = Boolean(readOnly);
    panel.setAttribute('data-readonly', readOnly ? '1' : '0');
  }

  // ---------- drafts: local first, then one sync at a time ----------

  // One place decides what the save line says, so the three code paths that change it cannot disagree:
  // an unconfirmed conflict first, then work this device still holds alone, then an acknowledged draft.
  function savedText(setId) {
    var me = info(setId);
    if (!me) return '';
    if (Object.keys(me.conflicts || {}).length) return '已保存在本机 · 请先确认上面的选择';
    if (me.gen !== me.ackedGen) return '已保存在本机';
    return me.rev ? '已保存' : '';
  }
  function saySaved(setId) {
    say(global.document.querySelector('[data-saved="' + setId + '"]'), savedText(setId));
  }
  function laterSync(setId, delay) {
    var me = info(setId);
    if (!me) return;
    if (me.syncTimer) global.clearTimeout(me.syncTimer);
    var mine = session;
    me.syncTimer = global.setTimeout(function () { if (mine === session) syncDraft(setId); }, delay);
  }

  // Each local change takes a new generation number. A reply acknowledges only the generation it
  // carried, so an answer typed while that request was running still counts as unsaved work.
  function scheduleSync(setId) {
    var me = info(setId);
    if (!me || me.status === 'submitted') return;
    me.gen += 1;
    saveLocalDraft(setId, me.attempt, readValues(setId));
    saySaved(setId);
    laterSync(setId, SYNC_DELAY);
  }

  function syncDraft(setId) {
    var me = info(setId);
    if (!me || me.syncing || me.submitting || me.status === 'submitted') return;
    // An unresolved same-field conflict is a deliberate Keep mine / Use saved choice. Nothing is sent
    // until it is confirmed: otherwise an ordinary edit to ANY other field would carry the disputed
    // answer to the server and settle the choice on the reader's behalf. Local edits keep being saved
    // on this device, and resolveConflicts resumes the save with exactly the chosen values.
    if (Object.keys(me.conflicts || {}).length) {
      saySaved(setId);
      return;
    }
    if (me.gen === me.ackedGen) return;
    var mine = session;
    var sentGen = me.gen;
    var values = localDraft(setId, me.attempt);
    me.syncing = true;
    post({ action: 'readingSaveDraft', token: token, setId: setId, attempt: me.attempt,
      baseRev: me.rev, values: values })
      .then(function (result) {
        if (mine !== session) return;
        me.syncing = false;
        if (result.ok) {
          me.rev = Number(result.rev) || 0;
          saveLocalRev(setId, me.attempt, me.rev);
          saveLocalBase(setId, me.attempt, values);
          me.ackedGen = sentGen;
          saySaved(setId);
          // Work arrived while that request was in flight: it is still unsaved, so send it.
          if (me.gen !== me.ackedGen) laterSync(setId, 200);
          return;
        }
        if (result.conflict) return reconcile(setId, result, sentGen);
        if (result.submitted || result.stale) return applyServerState(setId, result, true);
        if (result.closed) {
          me.receiving = false;
          say(global.document.querySelector('[data-saved="' + setId + '"]'), '已保存在本机');
          return;
        }
      })
      .catch(function () {
        if (mine !== session) return;
        me.syncing = false;
        say(global.document.querySelector('[data-saved="' + setId + '"]'), '已保存在本机 · 稍后再试');
        laterSync(setId, SYNC_DELAY * 5);
      });
  }

  // Field-by-field merge against the last acknowledged version. The server value is taken only where
  // this device has not changed that field; this device's value is kept where the server has not. A
  // field both sides changed is never resolved automatically — it is offered as a choice.
  function mergeDraft(setId, serverValues) {
    var me = info(setId);
    var mine = localDraft(setId, me.attempt);
    var base = localBase(setId, me.attempt);
    var set = loaded[setId];
    var merged = {};
    var conflicts = {};
    var ids = {};
    (set ? set.items.concat(set.extras) : []).forEach(function (item) { ids[item.id] = true; });
    Object.keys(mine).concat(Object.keys(serverValues || {})).forEach(function (id) { ids[id] = true; });
    Object.keys(ids).forEach(function (id) {
      var hasMine = Object.prototype.hasOwnProperty.call(mine, id);
      var hasTheirs = Object.prototype.hasOwnProperty.call(serverValues || {}, id);
      var myValue = hasMine ? mine[id] : undefined;
      var theirValue = hasTheirs ? serverValues[id] : undefined;
      if (!hasMine) { if (hasTheirs) merged[id] = theirValue; return; }
      if (!hasTheirs) { merged[id] = myValue; return; }
      if (same(myValue, theirValue)) { merged[id] = myValue; return; }
      var baseValue = Object.prototype.hasOwnProperty.call(base, id) ? base[id] : undefined;
      if (same(myValue, baseValue)) { merged[id] = theirValue; return; }      // untouched here
      if (same(theirValue, baseValue)) { merged[id] = myValue; return; }      // untouched there
      merged[id] = myValue;                                                   // keep what is on screen
      conflicts[id] = { mine: myValue, theirs: theirValue };
    });
    return { values: merged, conflicts: conflicts };
  }

  // True when the merged answers still hold something the saved draft does not. The merge already
  // takes every field only the server has, so this device can only be ahead, never behind. A field the
  // server has seen counts whenever it differs — including a deliberate clear back to an empty value —
  // and a field it has never seen counts only when it actually holds an answer.
  function blank(value) {
    return Array.isArray(value) ? !value.length : !String(value == null ? '' : value).trim();
  }
  function unsentAgainst(merged, serverValues) {
    var theirs = serverValues || {};
    return Object.keys(merged || {}).some(function (id) {
      if (!Object.prototype.hasOwnProperty.call(theirs, id)) return !blank(merged[id]);
      return !same(merged[id], theirs[id]);
    });
  }

  function reconcile(setId, result, sentGen) {
    var me = info(setId);
    var merged = mergeDraft(setId, result.values || {});
    me.rev = Number(result.rev) || 0;
    saveLocalRev(setId, me.attempt, me.rev);
    saveLocalBase(setId, me.attempt, result.values || {});
    saveLocalDraft(setId, me.attempt, merged.values);
    writeValues(setId, merged.values);
    me.conflicts = merged.conflicts;
    me.ackedGen = Object.keys(merged.conflicts).length ? me.ackedGen : sentGen;
    renderConflicts(setId);
    if (!Object.keys(merged.conflicts).length) {
      me.gen += 1;                                // the merged version still has to reach the server
      laterSync(setId, 200);
    }
    saySaved(setId);
  }

  function renderConflicts(setId) {
    var me = info(setId);
    var node = global.document.querySelector('[data-conflict="' + setId + '"]');
    if (!node) return;
    var ids = Object.keys(me.conflicts);
    if (!ids.length) { node.innerHTML = ''; node.hidden = true; return; }
    var set = loaded[setId];
    var byId = {};
    set.items.concat(set.extras).forEach(function (item) { byId[item.id] = item; });
    node.hidden = false;
    node.innerHTML = '<p class="conflict-head">这几题在别的地方也改过，请选择保留哪一个。</p>'
      + ids.map(function (id) {
        var item = byId[id] || { number: id };
        var pair = me.conflicts[id];
        return '<div class="conflict" data-conflict-item="' + esc(id) + '">'
          + '<p class="conflict-q">Q' + esc(item.number) + '</p>'
          + '<label class="conflict-opt"><input type="radio" name="cf-' + esc(id) + '" value="mine" checked>'
          + '<span>这台设备：' + esc(show(pair.mine)) + '</span></label>'
          + '<label class="conflict-opt"><input type="radio" name="cf-' + esc(id) + '" value="theirs">'
          + '<span>已保存的：' + esc(show(pair.theirs)) + '</span></label></div>';
      }).join('')
      + '<button type="button" class="primary" data-resolve="' + esc(setId) + '">确认</button>';
    node.querySelector('[data-resolve]').addEventListener('click', function () { resolveConflicts(setId); });
  }

  function show(value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : '（空）';
    return String(value == null || value === '' ? '（空）' : value);
  }

  function resolveConflicts(setId) {
    var me = info(setId);
    var node = global.document.querySelector('[data-conflict="' + setId + '"]');
    var values = localDraft(setId, me.attempt);
    Object.keys(me.conflicts).forEach(function (id) {
      var picked = node.querySelector('[name="cf-' + id + '"]:checked');
      var choice = picked ? picked.value : 'mine';
      values[id] = choice === 'theirs' ? me.conflicts[id].theirs : me.conflicts[id].mine;
    });
    // The conflicts are cleared BEFORE the save, which is what releases the guard in syncDraft. What
    // goes out is the local draft as it stands — the chosen values plus every other edit made while
    // the choice was open.
    me.conflicts = {};
    saveLocalDraft(setId, me.attempt, values);
    writeValues(setId, values);
    renderConflicts(setId);
    me.gen += 1;
    syncDraft(setId);
  }

  // ---------- rendering ----------

  function wrapTables(markup) {
    return String(markup == null ? '' : markup)
      .replace(/<table/g, '<div class="table-scroll"><table').replace(/<\/table>/g, '</table></div>');
  }

  // One answer field. Inside a group it prints only its own unique suffix and points at the shared
  // context with aria-describedby, so a screen reader announces the context with every gap. Its
  // wrapper, its data-field, its input ids, names and values are exactly what they were before
  // grouping: readValues, writeValues and setReadOnly address those and are untouched.
  function fieldHtml(item, group) {
    var marks = Number(item.marks) || 0;
    var label = item.required ? marks + (marks === 1 ? ' mark' : ' marks') : '选做';
    var promptHtml = group ? String(group.subPrompts[item.id] || '') : item.promptHtml;
    var input;
    if (item.type === 'choice' || item.type === 'multi') {
      var kind = item.type === 'multi' ? 'checkbox' : 'radio';
      input = '<div class="opts">' + (item.options || []).map(function (option, index) {
        var id = item.id + '-o' + index;
        return '<label class="opt" for="' + esc(id) + '">'
          + '<input type="' + kind + '" id="' + esc(id) + '" name="' + esc(item.id) + '" value="' + esc(option.value) + '">'
          + '<span>' + option.label + '</span></label>';
      }).join('') + '</div>';
    } else if (item.type === 'long') {
      input = '<textarea class="answer" rows="4" aria-label="Answer for question ' + esc(item.number) + '"></textarea>';
    } else {
      input = '<input type="text" class="answer" aria-label="Answer for question ' + esc(item.number) + '">';
    }
    return '<article class="qcard' + (item.required ? '' : ' optional') + (group ? ' grouped' : '')
      + '" data-field="' + esc(item.id) + '"'
      + (group ? ' aria-describedby="' + esc(groupDomId(group)) + '"' : '') + '>'
      + '<div class="qhead"><span class="qnum">Q' + esc(item.number) + '</span>'
      + '<span class="qmarks">' + esc(label) + '</span></div>'
      + (promptHtml ? '<div class="prompt">' + wrapTables(promptHtml) + '</div>' : '')
      + input + '</article>';
  }

  function groupDomId(group) {
    return 'gp-' + String(group.id);
  }

  // The printed questions of one list. A question whose single printed prompt covers several answer
  // fields prints that shared context ONCE, then each field follows as its own labelled control.
  // A field in no group is rendered exactly as before, with its complete prompt. A payload with no
  // promptGroups — an older service — renders exactly as before as well.
  function fieldListHtml(set, items) {
    var groups = set.promptGroups || [];
    var groupOf = {};
    groups.forEach(function (group) {
      (group.itemIds || []).forEach(function (itemId) { groupOf[itemId] = group; });
    });
    var done = {};
    var out = [];
    items.forEach(function (item) {
      var group = groupOf[item.id];
      if (!group) { out.push(fieldHtml(item, null)); return; }
      if (done[group.id]) return;
      done[group.id] = true;
      var members = group.itemIds.map(function (itemId) {
        return items.filter(function (candidate) { return candidate.id === itemId; })[0];
      }).filter(function (candidate) { return candidate; });
      out.push('<section class="qgroup" data-group="' + esc(group.id) + '">'
        + '<div class="qgroup-head"><span class="qnum">Q' + esc(group.questionNumber) + '</span>'
        // Neutral: a group is not always a set of gaps — some group a paraphrase classification or a
        // shared referent — so the header counts parts and never names the answer shape.
        + '<span class="qmarks">' + members.length + ' 小题 / parts</span></div>'
        + '<div class="prompt shared" id="' + esc(groupDomId(group)) + '">'
        + wrapTables(group.sharedPromptHtml) + '</div>'
        + members.map(function (member) { return fieldHtml(member, group); }).join('')
        + '</section>');
    });
    return out.join('');
  }

  function setHtml(set) {
    var extras = (set.extras || []).length
      ? '<section class="optional-block"><h3>讨论 / 写作（选做）</h3>'
        + fieldListHtml(set, set.extras) + '</section>'
      : '';
    return '<section class="set" data-set="' + esc(set.id) + '">'
      + '<header class="set-head"><span class="badge">' + esc(set.sourceLabel) + '</span>'
      + '<h2>' + esc(set.title) + '</h2></header>'
      + '<div class="passage">' + wrapTables(set.readingHtml) + '</div>'
      + '<div class="questions">' + fieldListHtml(set, set.items) + '</div>'
      + extras
      + '<section class="handin">'
      + '<div class="conflict-box" data-conflict="' + esc(set.id) + '" hidden></div>'
      + '<div class="actions"><button type="button" class="primary" data-submit="' + esc(set.id) + '">提交给老师</button>'
      + '<span class="saved" data-saved="' + esc(set.id) + '"></span></div>'
      + '<p class="status" data-handin-status="' + esc(set.id) + '" role="status"></p>'
      + '<div data-receipt="' + esc(set.id) + '"></div></section>'
      + '</section>';
  }

  function renderTabs() {
    el('tabs').innerHTML = sets.map(function (set) {
      return '<button type="button" class="tab" role="tab" data-open="' + esc(set.id) + '" aria-selected="false">'
        + esc(set.sourceLabel) + '</button>';
    }).join('');
    Array.prototype.forEach.call(el('tabs').querySelectorAll('[data-open]'), function (button) {
      button.addEventListener('click', function () { openSet(button.getAttribute('data-open')); });
    });
  }

  function showSet(setId) {
    activeSet = setId;
    Array.prototype.forEach.call(el('tabs').querySelectorAll('[data-open]'), function (button) {
      button.setAttribute('aria-selected', button.getAttribute('data-open') === setId ? 'true' : 'false');
    });
    Array.prototype.forEach.call(el('panels').querySelectorAll('[data-set]'), function (panel) {
      panel.hidden = panel.getAttribute('data-set') !== setId;
    });
  }

  function bindSet(setId) {
    var panel = el('panels').querySelector('[data-set="' + setId + '"]');
    Array.prototype.forEach.call(panel.querySelectorAll('.answer'), function (field) {
      field.addEventListener('input', function () { scheduleSync(setId); });
    });
    Array.prototype.forEach.call(panel.querySelectorAll('.opt input'), function (box) {
      box.addEventListener('change', function () { scheduleSync(setId); });
    });
    panel.querySelector('[data-submit]').addEventListener('click', function () { submit(setId); });
  }

  function openSet(setId) {
    var id = byKey[setId] || setId;
    if (loaded[id]) { showSet(id); return Promise.resolve(); }
    var status = el('gateStatus');
    var mine = session;
    say(status, '…');
    return post({ action: 'readingLibrary', token: token, setId: id })
      .then(function (result) {
        if (mine !== session) return;
        if (result.storageScope) rememberScope(result.storageScope);
        loaded[id] = result.set;
        state[id] = state[id] || blankState(id);
        state[id].receiving = result.receiving !== false;
        var panel = global.document.createElement('div');
        panel.innerHTML = setHtml(result.set);
        el('panels').appendChild(panel.firstChild || panel);
        bindSet(id);
        say(status, '');
        showSet(id);
        return restore(id);
      })
      .catch(function (error) {
        if (mine !== session) return;
        say(status, error.message || '打不开这一篇。', 'error');
      });
  }

  // The device draft is shown at once; the saved draft is then merged into it, never pasted over it.
  function applyServerState(setId, result, keepLocal) {
    var me = info(setId);
    var attempt = Number(result.attempt) || 1;
    if (attempt !== me.attempt) {
      // The teacher opened a new attempt (or this tab was behind): that attempt has its own draft.
      me.attempt = attempt;
      me.rev = localRev(setId, attempt);
      me.gen = 0;
      me.ackedGen = 0;
      me.conflicts = {};
      writeValues(setId, blankValues(setId));
      writeValues(setId, localDraft(setId, attempt));
    }
    me.status = result.status === 'submitted' ? 'submitted' : 'open';
    me.receiving = result.receiving !== false;
    me.released = result.released !== false;
    me.receipt = result.receipt || me.receipt;
    if (result.draft) {
      var serverRev = Number(result.draft.rev) || 0;
      var serverValues = result.draft.values || {};
      var merged = mergeDraft(setId, serverValues);
      me.rev = serverRev;
      saveLocalRev(setId, attempt, serverRev);
      saveLocalBase(setId, attempt, serverValues);
      if (!keepLocal || me.status !== 'submitted') {
        saveLocalDraft(setId, attempt, merged.values);
        writeValues(setId, merged.values);
      }
      me.conflicts = merged.conflicts;
      renderConflicts(setId);
      // Answers written while this device was offline survive the merge, but the server has never seen
      // them. Restoring them onto the screen is NOT saving them: mark the difference as a new unsent
      // generation and schedule it, so a reader who signs in again and types nothing still has their
      // work sent — and still sees 已保存在本机 until the server acknowledges it. A cleared answer is
      // one of those differences. A locked submitted attempt is never resaved, and an unconfirmed
      // conflict waits for the reader's choice first.
      if (me.status !== 'submitted' && !Object.keys(merged.conflicts).length
        && unsentAgainst(merged.values, serverValues)) {
        me.gen += 1;
        laterSync(setId, 200);
      }
    }
    if (me.status === 'submitted') {
      setReadOnly(setId, true);
      say(global.document.querySelector('[data-saved="' + setId + '"]'), '');
      if (me.receipt) showReceipt(setId, me.receipt);
      say(global.document.querySelector('[data-handin-status="' + setId + '"]'), '');
    } else {
      setReadOnly(setId, false);
      clearReceipt(setId);
      saySaved(setId);
    }
  }

  function blankValues(setId) {
    var set = loaded[setId];
    var out = {};
    if (!set) return out;
    set.items.concat(set.extras).forEach(function (item) { out[item.id] = item.type === 'multi' ? [] : ''; });
    return out;
  }

  function restore(setId) {
    var me = info(setId);
    writeValues(setId, localDraft(setId, me.attempt));
    var mine = session;
    return post({ action: 'readingState', token: token, setId: setId }).then(function (result) {
      if (mine !== session) return;
      if (result.storageScope) rememberScope(result.storageScope);
      applyServerState(setId, result, false);
      return resolvePending(setId);
    }).catch(function () { /* the device draft is already on screen */ });
  }

  // One rule for every reply that carries a receipt: it may be applied only when the attempt it was
  // sent for is still the attempt on screen AND the receipt names that same attempt. Both halves are
  // needed — the captured attempt alone cannot tell that the teacher has since opened the next one.
  function staleReply(me, attempt, result) {
    return me.attempt !== attempt || Number(result && result.attempt) !== attempt;
  }

  // A hand-in may have been stored while the reply was lost. The same request ID is asked about until
  // its outcome is known; it is never replaced by a new one for the same attempt. The attempt that
  // request was made for is sent with it, because a receipt only answers for the attempt it names.
  function resolvePending(setId) {
    var me = info(setId);
    if (me.status === 'submitted') return Promise.resolve();
    var attempt = me.attempt;
    var k = key('request', setId, attempt);
    if (!store(k)) return Promise.resolve();
    var mine = session;
    return post({ action: 'readingReceipt', token: token, setId: setId, attempt: attempt,
      requestId: store(k) })
      .then(function (check) {
        if (mine !== session || !check || !check.found || !check.result) return;
        // An older attempt's receipt must never lock an attempt the teacher has since opened.
        if (Number(check.result.attempt) !== me.attempt || attempt !== me.attempt) return;
        me.status = 'submitted';
        me.receipt = check.result;
        setReadOnly(setId, true);
        showReceipt(setId, check.result);
      }).catch(function () { /* offline: the page stays as it is */ });
  }

  // ---------- deliberate hand-in ----------

  function missingRequired(setId) {
    var set = loaded[setId];
    var values = readValues(setId);
    return set.items.filter(function (item) {
      var value = values[item.id];
      return Array.isArray(value) ? !value.length : !String(value == null ? '' : value).trim();
    });
  }

  function clearReceipt(setId) {
    var node = global.document.querySelector('[data-receipt="' + setId + '"]');
    if (node) node.innerHTML = '';
  }

  function showReceipt(setId, receipt) {
    var node = global.document.querySelector('[data-receipt="' + setId + '"]');
    if (!node || !receipt) return;
    node.innerHTML = '<p class="receipt">已提交 · Handed in'
      + '<span>回执编号 ' + esc(receipt.receiptId) + '</span>'
      + '<span>' + esc(new Date(receipt.receivedAt).toLocaleString()) + ' · 第 '
        + esc(receipt.attempt) + ' 次</span>'
      + '<span>这一次已锁定。需要再写一次时，老师会打开下一次。</span></p>';
  }

  function submit(setId) {
    var me = info(setId);
    var status = global.document.querySelector('[data-handin-status="' + setId + '"]');
    var button = global.document.querySelector('[data-submit="' + setId + '"]');
    if (!me || me.submitting) return Promise.resolve();
    if (me.status === 'submitted') { say(status, '这一次已经提交过了。', 'error'); return Promise.resolve(); }
    if (me.receiving === false) { say(status, '现在暂时不能提交，请稍后再试。', 'error'); return Promise.resolve(); }
    if (Object.keys(me.conflicts).length) { say(status, '请先确认上面那几题保留哪一个。', 'error'); return Promise.resolve(); }
    var missing = missingRequired(setId);
    if (missing.length) {
      say(status, '还有 ' + missing.length + ' 道题没有作答（Q' + missing[0].number + ' 起）。', 'error');
      return Promise.resolve();
    }
    me.submitting = true;
    button.disabled = true;
    say(status, '提交中…');
    var values = readValues(setId);
    var attempt = me.attempt;
    saveLocalDraft(setId, attempt, values);
    var id = requestId(setId, attempt);
    var mine = session;
    // An owner preview collects no origin: a test hand-in must not record a device or a place.
    return (preview ? Promise.resolve({}) : collectOrigin()).then(function (origin) {
      return post({ action: 'readingSubmit', token: token, setId: setId, attempt: attempt, requestId: id,
        values: values, clientTime: new Date().toISOString(), submissionOrigin: origin || {} });
    }).then(function (result) {
      if (mine !== session) return;
      me.submitting = false;
      // A reply answers only for the attempt it was sent for. While it was in flight the teacher may
      // have opened the next attempt (restore then moves this set to attempt n+1/open and re-enables
      // its controls). Applying an older attempt's receipt there would lock work the reader is allowed
      // to be writing, so a stale reply changes no receipt, no lock, no status and no control. The
      // request ID stays in device storage under its own attempt key, so the old receipt is still
      // recoverable for that attempt.
      if (!staleReply(me, attempt, result)) {
        me.status = 'submitted';
        me.receipt = result;
        say(status, '');
        showReceipt(setId, result);
        setReadOnly(setId, true);   // the attempt stays locked until the teacher opens the next one
      }
    }).catch(function (error) {
      if (mine !== session) return;
      me.submitting = false;
      // Re-enabling belongs to the attempt this submission was for. A newer attempt has already been
      // given its own read-only state, and a submitted one must stay locked.
      if (me.attempt === attempt && me.status !== 'submitted') button.disabled = false;
      return post({ action: 'readingReceipt', token: token, setId: setId, attempt: attempt,
        requestId: id }).then(function (check) {
        if (mine !== session) return;
        var found = Boolean(check && check.found && check.result && check.result.receiptId);
        // A receipt for an attempt that is no longer the current one is history, not this screen: it
        // neither locks nor clears the newer attempt, and it does not overwrite its message either.
        if (found && staleReply(me, attempt, check.result)) return;
        if (found) {
          me.status = 'submitted';
          me.receipt = check.result;
          say(status, '');
          showReceipt(setId, check.result);
          setReadOnly(setId, true);
          return;
        }
        say(status, (error && error.message) || '提交没有成功，请再试一次。', 'error');
      }).catch(function () {
        if (me.attempt !== attempt) return;
        say(status, (error && error.message) || '提交没有成功，请再试一次。', 'error');
      });
    });
  }

  // ---------- sign in / forget ----------

  function rememberScope(value) {
    var next = String(value || '');
    if (!next || next === scope) return;
    scope = next;
    // An owner preview is a visit, not this device's reader: it keeps its scope in memory only, so the
    // reader's own saved sign-in and saved answers are left exactly as they were.
    if (!preview) keep(SCOPE_KEY, scope);
  }

  function startWorkspace() {
    el('gate').hidden = true;
    el('workspace').hidden = false;
    el('printBtn').hidden = false;
    el('forgetBtn').hidden = false;
    var mine = session;
    return post({ action: 'readingLibrary', token: token }).then(function (result) {
      if (mine !== session) return;
      if (result.storageScope) rememberScope(result.storageScope);
      sets = (result.sets || []).sort(function (a, b) { return a.order - b.order; });
      byKey = {};
      sets.forEach(function (set) { byKey[set.key] = set.id; });
      renderTabs();
      var wanted = String(global.location && global.location.hash || '').replace('#', '');
      var first = byKey[wanted] || (sets.length ? sets[0].id : '');
      if (first) return openSet(first);
    }).catch(function (error) {
      if (mine !== session) return;
      if (/sign in/i.test(error.message || '')) return forget(true);
      say(el('gateStatus'), error.message || '打不开阅读练习。', 'error');
    });
  }

  function signIn(passphrase) {
    var status = el('gateStatus');
    var button = el('signInBtn');
    button.disabled = true;
    say(status, '…');
    return post({ action: 'readingAuthenticate', passphrase: passphrase }).then(function (result) {
      resetSession();                 // a different reader must never inherit the last one's state
      preview = false;
      token = result.token;
      keep(TOKEN_KEY, token);
      rememberScope(result.storageScope);
      button.disabled = false;
      say(status, '');
      return startWorkspace();
    }).catch(function (error) {
      button.disabled = false;
      say(status, error.message || '登录没有成功。', 'error');
    });
  }

  // ---------- the teacher's own preview of this page ----------
  // The teacher workspace links here with the project's standard ?tp=<proof>. The proof is the EXISTING
  // owner-signed preview token; this page only hands it to the service, which verifies the signature
  // and derives the test session itself. This page cannot ask for an actor or an environment, so a
  // preview link can never open the learner's own production session, and no passphrase is involved.
  //
  // Whether `tp` is THERE and what its value is are two separate questions. `?tp=`, `?tp` and a value
  // that cannot be decoded are all still an explicit request for the owner preview, so they are
  // answered by the preview path — which refuses them and leaves the gate up. Treating an empty value
  // as "no preview asked for" is what would let such a link open the reader's own saved production
  // sign-in instead, which is the one thing a preview link must never do.
  function previewRequest() {
    var places = [String(global.location && global.location.search || ''),
      String(global.location && global.location.hash || '')];
    for (var i = 0; i < places.length; i += 1) {
      var found = /[?&]tp(?:=([^&#]*))?(?=[&#]|$)/.exec(places[i]);
      if (!found) continue;
      var raw = found[1] == null ? '' : found[1];
      try { return { present: true, proof: decodeURIComponent(raw) }; } catch (e) { return { present: true, proof: raw }; }
    }
    return { present: false, proof: '' };
  }

  function previewProof() {
    return previewRequest().proof;
  }

  function signInWithPreview(proof) {
    var status = el('gateStatus');
    // An empty or unusable value is refused here, without a request: the service would read it as an
    // ordinary sign-in attempt and count it against the learner's own sign-in throttle.
    if (!String(proof || '')) {
      preview = false;
      token = '';
      say(status, '这个预览链接打不开了。', 'error');
      return Promise.resolve();
    }
    say(status, '…');
    return post({ action: 'readingAuthenticate', previewToken: proof }).then(function (result) {
      resetSession();
      preview = true;                 // set before the scope, so nothing is written to this device
      token = result.token;
      rememberScope(result.storageScope);
      var note = el('previewNote');
      if (note) note.hidden = false;
      say(status, '');
      return startWorkspace();
    }).catch(function (error) {
      preview = false;
      token = '';
      say(status, (error && error.message) || '这个预览链接打不开了。', 'error');
    });
  }

  // Cancels every timer and in-flight callback and clears the in-memory state. The saved answers on
  // this device stay where they are, under their own reader's scope.
  function resetSession() {
    session += 1;
    Object.keys(state).forEach(function (setId) {
      if (state[setId].syncTimer) global.clearTimeout(state[setId].syncTimer);
    });
    loaded = {};
    state = {};
    sets = [];
    byKey = {};
    activeSet = '';
    originReady = null;
  }

  // Removes the saved sign-in only. Every draft on this device is kept, under its own scope.
  function forget(silent) {
    var wasPreview = preview;
    resetSession();
    token = '';
    preview = false;
    if (wasPreview) {
      // Closing an owner preview must not sign the reader out: the preview never owned this device's
      // saved sign-in, so the reader's token, scope and drafts are all left in place.
      scope = store(SCOPE_KEY) || '';
    } else {
      scope = '';
      drop(TOKEN_KEY);
      drop(SCOPE_KEY);
    }
    var note = el('previewNote');
    if (note) note.hidden = true;
    el('panels').innerHTML = '';
    el('tabs').innerHTML = '';
    el('workspace').hidden = true;
    el('printBtn').hidden = true;
    el('forgetBtn').hidden = true;
    el('gate').hidden = false;
    var field = el('passphrase');
    if (field) field.value = '';
    say(el('gateStatus'), silent ? '请重新登录。' : '已退出登录。');
  }

  function init() {
    var form = el('signInForm');
    form.addEventListener('submit', function (event) {
      if (event && event.preventDefault) event.preventDefault();
      signIn(el('passphrase').value);
    });
    el('printBtn').addEventListener('click', function () { global.print(); });
    el('forgetBtn').addEventListener('click', function () { forget(false); });
    var saved = store(TOKEN_KEY);
    scope = store(SCOPE_KEY) || '';
    // A ?tp= preview link opens the teacher's test session and nothing else: the reader's own saved
    // sign-in is deliberately not used here, and a preview token is never one of the saved forms below.
    var asked = previewRequest();
    if (asked.present) return signInWithPreview(asked.proof);
    if (/^v1\.[a-z]+\.\d{10}\.[a-f0-9]{40}$/.test(saved || '')) {
      token = saved;
      startWorkspace();
    }
  }

  global.JackyReading = { init: init, signIn: signIn, forget: forget, submit: submit,
    openSet: openSet, readValues: readValues, writeValues: writeValues, restore: restore,
    scheduleSync: scheduleSync, syncDraft: syncDraft, resolveConflicts: resolveConflicts,
    signInWithPreview: signInWithPreview, state: function () { return state; },
    scope: function () { return scope; }, preview: function () { return preview; } };

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : this);
