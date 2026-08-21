(function () {
  'use strict';

  var DAY = 86400000;
  var LOCAL_KEY = 'beiji_local_v3';            // 旧版单人存储键（用于首次迁移）
  var LOCAL_AUTH_KEY = 'beiji_auth_v1';        // 本机登录账号（唯一，不可重复注册）
  var SESSION_KEY = 'beiji_session_v3';
  var currentAccount = null;                   // 当前登录的账号名（local 模式）

  var THEMES = [
    { key: 'mint-rabbit', name: '玉兔狗🐰薄荷绿', icon: '🐰' },
    { key: 'milk-dragon', name: '奶龙🐲奶黄天蓝', img: 'themes/nailong.jpg' },
    { key: 'line-dog', name: '线条狗🐶墨蓝', img: 'themes/linedog2.jpg' },
    { key: 'cat', name: '猫咪🐱奶茶抹茶', icon: '🐱' },
    { key: 'bear', name: '小熊🐻可可', icon: '🐻' },
    { key: 'mint', name: '薄荷🌿默认', icon: '🌿' },
    { key: 'orange', name: '橘宝🍊', icon: '🍊' },
    { key: 'sky', name: '天青💧', icon: '💧' },
    { key: 'matcha', name: '抹茶🍵', icon: '🍵' },
    { key: 'jasmine', name: '茉莉🌼', icon: '🌼' }
  ];

  // 全局状态
  var MODE = 'local';            // 运行时在 init() 按托管域名自动判定：github.io/githubusercontent → 'github'（云端同步）；否则 'local'
  var session = null;            // {token, username}（仅 server 模式）
  var state = emptyState();
  var view = 'add';
  var reviewQueue = null;
  var exam = null;
  var viewEl, tabEl, subEl, overlayEl, authEl, userbarEl, unameEl, authMsgEl;
  var importState = { text: '', mode: 'qa', preview: [], book: '' };
  var saveTimer = null;
  var loadingEl = null;
  var GITHUB_KEY = 'beiji_gh';
  function ghCfg() { try { return JSON.parse(localStorage.getItem(GITHUB_KEY) || 'null'); } catch (e) { return null; } }
  function setGhCfg(c) { try { localStorage.setItem(GITHUB_KEY, JSON.stringify(c)); } catch (e) {} }
  function utf8ToBase64(str) {
    try { return btoa(unescape(encodeURIComponent(str))); }
    catch (e) {
      var b = new TextEncoder().encode(str), s = '', i = 0, n = b.length;
      for (; i < n; i++) s += String.fromCharCode(b[i]);
      return btoa(s);
    }
  }
  function base64ToUtf8(b64) { var bin = atob(b64), bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes); }

  /* ---------- 本机登录（local 模式，单账号、数据隔离） ---------- */
  // 账号只此一个，首次设置后不可再注册；密码仅做本机门禁（非真加密，防止误触他人设备）
  function localAuthGet() { try { return JSON.parse(localStorage.getItem(LOCAL_AUTH_KEY) || 'null'); } catch (e) { return null; } }
  function localAuthSet(account, hash) { try { localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify({ account: account, hash: hash })); } catch (e) {} }
  function dataKey(account) { return 'beiji_data_v1_' + account; }
  function hashPwd(pwd, salt) {
    var h = 0x811c9dc5;
    for (var i = 0; i < pwd.length; i++) { h ^= pwd.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8) + ':' + (salt ? salt.length : 0);
  }
  // 本机缓存读取（云端同步时的离线兜底）：优先当前账号键，其次旧版单人键
  function localCacheLoad() {
    try {
      var key = dataKey(currentAccount);
      var raw = localStorage.getItem(key);
      if (raw) { var d = JSON.parse(raw); if (d && typeof d === 'object') return d; }
      var old = localStorage.getItem(LOCAL_KEY);
      if (old) { var od = JSON.parse(old); if (od && typeof od === 'object') return od; }
    } catch (e) {}
    return emptyState();
  }
  // 把当前登录账号同步进 GitHub 配置（云端数据按账号分文件存储）
  function syncGhAccount() {
    var cur = currentAccount || (localAuthGet() && localAuthGet().account);
    if (!cur) return;
    var c = ghCfg() || {};
    c.account = cur;
    setGhCfg(c);
  }

  /* ---------- 工具 ---------- */
  function emptyState() {
    return { cards: [], checkins: [], theme: 'mint', ai: { url: '', key: '', model: 'gpt-4o-mini' }, bookOrder: [] };
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function esc(s) {
    return (s == null ? '' : '' + s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function setVal(id, v) { var e = document.getElementById(id); if (e) e.value = v; }
  function $(id) { return document.getElementById(id); }

  // 补全卡片的 SM-2 字段（兼容旧数据）
  function normalizeCard(c) {
    if (c.ef == null) c.ef = 2.5;
    if (c.reps == null) c.reps = 0;
    if (c.interval == null) c.interval = 0;
    if (c.due == null) c.due = 0;
    if (!c.id) c.id = uid();
    if (!Array.isArray(c.points)) c.points = [];
    if (c.cloze == null) c.cloze = false;
    return c;
  }
  function newCard(book, q, a) {
    return { id: uid(), book: book, q: q, a: a || '', ef: 2.5, reps: 0, interval: 0, due: 0, created: Date.now() };
  }

  function bookList() {
    var s = {}, order = state.bookOrder || [];
    state.cards.forEach(function (c) { if (c.book) s[c.book] = (s[c.book] || 0) + 1; });
    var keys = Object.keys(s).sort();
    // 优先按 bookOrder 排序
    keys.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0) ia = 999; if (ib < 0) ib = 999;
      return ia - ib;
    });
    return keys;
  }
  function dueCards() {
    var now = Date.now();
    return state.cards.filter(function (c) { return (c.due || 0) <= now; });
  }
  function familiarity(c) {
    // 0-100，越高越熟
    var f = (c.ef - 1.3) / 1.2 * 100;
    return Math.round(Math.max(0, Math.min(100, f)));
  }
  function streak() {
    var set = {};
    state.checkins.forEach(function (d) { set[d] = true; });
    var n = 0, d = new Date();
    if (!set[todayStr()]) d.setDate(d.getDate() - 1);
    while (set[d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  /* ---------- 存储 / 账户层 ---------- */
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }
  function saveData(d) {
    if (MODE === 'server') {
      return api('POST', '/api/data', { token: session.token, data: d }).then(function (j) {
        if (j._status === 401) { toast('登录已失效，请重新登录'); doLogout(); }
        return j;
      });
    }
    // 统一只序列化一次，避免大文件重复 stringify
    var json = '';
    try { json = JSON.stringify(d); } catch (e) {}
    if (MODE === 'github') {
      // GitHub 模式以仓库文件为权威存储；localStorage 只是离线缓存。
      // 如果数据太大，跳过本地缓存避免主线程卡死和超出配额。
      if (json && json.length <= 800000) {
        try { localStorage.setItem(dataKey(currentAccount), json); } catch (e) {}
      } else if (json) {
        try { localStorage.setItem(dataKey(currentAccount) + '_meta', JSON.stringify({ savedAt: Date.now(), size: json.length })); } catch (e) {}
      }
      return ghSave(d, json);
    }
    if (json) {
      try { localStorage.setItem(dataKey(currentAccount), json); } catch (e) { toast('保存失败：存储可能已满'); }
    }
    return Promise.resolve({});
  }
  function loadData() {
    if (MODE === 'server') {
      return api('GET', '/api/data?token=' + session.token).then(function (j) {
        if (j._status === 401) { doLogout(); return emptyState(); }
        return j.data || emptyState();
      });
    }
    if (MODE === 'github') {
      var localCache = localCacheLoad();
      var c = ghCfg();
      if (!c || !c.token || !c.user || !c.repo || !c.account) return Promise.resolve(localCache);
      return ghLoad().then(function (cloud) {
        if (cloud && (cloud.cards || cloud.books || cloud.checkins)) return cloud;
        return localCache;
      }).catch(function () { return localCache; });
    }
    try {
      var key = dataKey(currentAccount);
      var raw = localStorage.getItem(key);
      if (raw) { var d = JSON.parse(raw); if (d && typeof d === 'object') return Promise.resolve(d); }
      // 首次：尝试从旧版本键迁移已有数据，避免丢卡
      var old = localStorage.getItem(LOCAL_KEY);
      if (old) { var od = JSON.parse(old); if (od && typeof od === 'object') { localStorage.setItem(key, old); return Promise.resolve(od); } }
    } catch (e) {}
    return Promise.resolve(emptyState());
  }
  function ghSave(d, prejson) {
    var c = ghCfg();
    if (!c || !c.token || !c.user || !c.repo || !c.account) return Promise.resolve({});
    var sha;
    var path = 'data/' + encodeURIComponent(c.account) + '.json';
    var api = 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/' + path;
    var headers = { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' };
    var content = utf8ToBase64(prejson || JSON.stringify(d));
    return fetch(api, { headers: headers })
      .then(function (r) { if (r.status === 200) return r.json().then(function (j) { sha = j.sha; }); return null; })
      .then(function () {
        return fetch(api, { method: 'PUT', headers: headers, 'Content-Type': 'application/json',
          body: JSON.stringify({ message: 'backup ' + c.account + ' ' + new Date().toISOString(), content: content, sha: sha }) });
      })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return { _status: r.status }; })
      .catch(function (e) { toast('GitHub 备份失败（离线时本地数据仍有效）'); return {}; });
  }
  function ghLoad() {
    var c = ghCfg();
    if (!c || !c.token || !c.user || !c.repo || !c.account) return Promise.resolve(emptyState());
    var path = 'data/' + encodeURIComponent(c.account) + '.json';
    var api = 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/' + path;
    return fetch(api, { headers: { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' } })
      .then(function (r) {
        if (r.status === 404) return emptyState();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j && j.content) { try { return JSON.parse(base64ToUtf8(j.content)); } catch (e) { return emptyState(); } }
        return emptyState();
      })
      .catch(function (e) { toast('GitHub 读取失败，使用本地数据'); return emptyState(); });
  }
  function save() {
    // 剥离会话级临时字段
    state.cards.forEach(function (c) { delete c._revealed; });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveData(state); }, 300);
  }

  /* ---------- 复习算法（SM-2 变体，参考墨墨） ---------- */
  // q: 1=忘记, 3=模糊, 5=认识
  function grade(card, q) {
    var ef = card.ef, reps = card.reps, interval = card.interval;
    if (q < 3) {                       // 忘记：立刻重来，本轮再出现
      reps = 0; interval = 0; ef = Math.max(1.3, ef - 0.3);
    } else if (q === 3) {              // 模糊：明天再巩固，熟悉度下调
      reps = 0; interval = 1; ef = Math.max(1.3, ef - 0.15);
    } else {                           // 认识：推进间隔
      if (reps === 0) interval = 1;
      else if (reps === 1) interval = 6;
      else interval = Math.round(interval * ef);
      reps++;
      ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
      if (ef < 1.3) ef = 1.3;
    }
    card.ef = ef; card.reps = reps; card.interval = interval;
    card.due = Date.now() + interval * DAY;
    card.lastGrade = q;
    return card;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    viewEl = $('view'); tabEl = $('tabbar'); subEl = $('subtitle');
    overlayEl = $('overlay'); authEl = $('auth'); userbarEl = $('userbar');
    unameEl = $('uname'); authMsgEl = $('auth-msg');

    applyTheme();

    // 登录按钮（统一入口：server 走后端登录，local 走本机账号）；不需要注册
    if ($('btn-login')) $('btn-login').onclick = onAuthSubmit;
    if ($('btn-register')) $('btn-register').style.display = 'none';
    if ($('logout')) $('logout').onclick = doLogout;

    viewEl.addEventListener('click', onClick);
    tabEl.addEventListener('click', onClick);
    if (overlayEl) overlayEl.addEventListener('click', function (e) { if (e.target === overlayEl) closeImportModal(); });

    // 托管在 GitHub Pages 上 → 强制云端同步模式
    if (location.hostname.indexOf('github.io') >= 0 || location.hostname.indexOf('githubusercontent.com') >= 0) {
      MODE = 'github'; boot(); return;
    }
    // 本地/云工作室：优先已配置的云端；否则探测后端；最后单人本地
    var g = ghCfg();
    if (g && g.token && g.user && g.repo && g.account) {
      MODE = 'github'; boot();
    } else {
      fetch('/api/ping').then(function (r) { return r.json(); }).then(function (j) {
        MODE = (j && j.mode === 'server') ? 'server' : 'local';
      }).catch(function () { MODE = 'local'; }).then(boot);
    }
  }

  function boot() {
    if (MODE === 'github') {
      // 先过本机登录门禁（单账号），登录后按账号从 GitHub 拉取数据
      var la = localAuthGet();
      if (!la) showLocalSetup();
      else showLocalLogin(la.account);
      return;
    }
    if (MODE === 'server') {
      var s = null;
      try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
      if (s && s.token) {
        session = s;
        loadData().then(function (d) {
          if (!d.cards && d._status === 401) { showAuth(); return; }
          enterApp(d);
        });
      } else {
        showAuth();
      }
    } else {
      // local 模式：先过本机登录门禁（首次需设置唯一账号）
      var la = localAuthGet();
      if (!la) showLocalSetup();
      else showLocalLogin(la.account);
    }
  }

  function showAuth() {
    if (authEl) { authEl.classList.remove('hidden'); authEl.classList.add('show'); }
    if (userbarEl) userbarEl.classList.add('hidden');
    if (viewEl) viewEl.innerHTML = '';
    if (tabEl) tabEl.innerHTML = '';
    if (subEl) subEl.textContent = '';
  }
  function enterApp(d) {
    state = d || emptyState();
    state.cards = (state.cards || []).map(normalizeCard);
    state.checkins = state.checkins || [];
    state.theme = state.theme || 'mint';
    state.ai = state.ai || { url: '', key: '', model: 'gpt-4o-mini' };
    state.bookOrder = state.bookOrder || [];
    applyTheme();
    if (authEl) { authEl.classList.remove('show'); authEl.classList.add('hidden'); }
    if (userbarEl) {
      userbarEl.classList.remove('hidden');
      if (unameEl) unameEl.textContent = (MODE === 'server' ? (session && session.username) : currentAccount) || '';
    }
    renderTabbar();
    show('add');
  }

  function doAuth(kind) {
    var u = val('au').trim(), p = val('ap');
    if (!u || !p) { authMsg('用户名和密码都要填'); return; }
    if (p.length < 6) { authMsg('密码至少 6 位'); return; }
    var path = kind === 'register' ? '/api/register' : '/api/login';
    api('POST', path, { username: u, password: p }).then(function (j) {
      if (j._status !== 200 || !j.token) { authMsg(j.error || '操作失败'); return; }
      session = { token: j.token, username: j.username };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
      authMsg('');
      loadData().then(enterApp);
    }).catch(function () { authMsg('网络错误，确认服务已启动'); });
  }
  function authMsg(m) { if (authMsgEl) authMsgEl.textContent = m || ''; }
  function onAuthSubmit() {
    if (MODE === 'server') { doAuth('login'); return; }
    // local 与 github 模式共用本机登录（单账号，数据隔离）
    var la = localAuthGet();
    if (!la) localSetup(); else localLogin();
  }
  // 首次使用：设置唯一本机账号（仅此一个，不可再注册）
  function showLocalSetup() {
    showAuth();
    var card = authEl ? authEl.querySelector('.authcard') : null;
    if (card) {
      var sub = card.querySelector('.asub'); if (sub) sub.textContent = (MODE === 'github'
        ? '首次使用 · 设置一个登录账号（一个账号对应一份数据，自动存到你 GitHub 私人仓库，手机电脑通用）'
        : '首次使用 · 设置一个本机登录账号（一个账号对应一份独立数据，之后不可重复注册）');
      var btn = $('btn-login'); if (btn) btn.textContent = '设置并进入';
    }
    authMsg('');
  }
  // 已设置过账号：登录
  function showLocalLogin(account) {
    showAuth();
    var card = authEl ? authEl.querySelector('.authcard') : null;
    if (card) {
      var sub = card.querySelector('.asub'); if (sub) sub.textContent = '本机登录 · 数据存在这台设备，密码仅本机使用';
      var btn = $('btn-login'); if (btn) btn.textContent = '登录';
    }
    if ($('au')) $('au').value = account || '';
    authMsg('');
  }
  function localSetup() {
    var u = val('au').trim(), p = val('ap');
    if (!u) { authMsg('请填写账号名'); return; }
    if (p.length < 6) { authMsg('密码至少 6 位'); return; }
    localAuthSet(u, hashPwd(p, u));
    currentAccount = u;
    syncGhAccount();
    authMsg('');
    loadData().then(enterApp);
  }
  function localLogin() {
    var u = val('au').trim(), p = val('ap');
    if (!u || !p) { authMsg('账号和密码都要填'); return; }
    var la = localAuthGet();
    if (!la) { showLocalSetup(); return; }
    if (u !== la.account) { authMsg('账号不存在'); return; }
    if (hashPwd(p, la.account) !== la.hash) { authMsg('密码错误'); return; }
    currentAccount = la.account;
    syncGhAccount();
    authMsg('');
    loadData().then(enterApp);
  }
  function doLogout() {
    if (MODE === 'server' && session) {
      api('POST', '/api/logout', { token: session.token });
    }
    session = null; currentAccount = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (MODE === 'local') { var la = localAuthGet(); if (la) showLocalLogin(la.account); else showLocalSetup(); }
    else showAuth();
  }

  function applyTheme() {
    document.body.className = 'theme-' + state.theme;
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) {
      var c = getComputedStyle(document.body).getPropertyValue('--primary').trim() || '#21b5a6';
      meta.setAttribute('content', c);
    }
  }
  function renderTabbar() {
    if (MODE === 'server' && !session) return; // 未登录不渲染
    var TABS = [
      ['add', '➕', '录入'], ['review', '🔁', '复习'], ['exam', '📝', '模拟考'],
      ['checkin', '✅', '签到'], ['library', '📚', '书库'], ['mine', '⚙️', '我的']
    ];
    tabEl.innerHTML = TABS.map(function (t) {
      return '<button class="tab ' + (t[0] === view ? 'on' : '') + '" data-act="tab" data-arg="' + t[0] + '">' +
        '<span class="ti">' + t[1] + '</span><span class="tl">' + t[2] + '</span></button>';
    }).join('');
  }
  function show(name) {
    view = name;
    if (name === 'review' && !reviewQueue) reviewQueue = dueCards();
    render();
  }
  function render() {
    renderTabbar();
    var SUB = { add: '录入新卡片', review: '该复习啦', exam: '自测一下', checkin: '每天打卡', library: '管理书架', mine: '设置与备份' };
    subEl.textContent = SUB[view] || '';
    if (view === 'add') viewAdd();
    else if (view === 'review') viewReview();
    else if (view === 'exam') viewExam();
    else if (view === 'checkin') viewCheckin();
    else if (view === 'library') viewLibrary();
    else if (view === 'mine') viewMine();
  }

  /* ---------- 各页面 ---------- */
  function viewAdd() {
    var opts = bookList().map(function (b) { return '<option value="' + esc(b) + '">'; }).join('');
    viewEl.innerHTML =
      '<div class="card">' +
      '<label class="lbl">所属书 / 科目</label>' +
      '<input id="f-book" list="bookopts" placeholder="如：经济法 / 英语单词" class="inp">' +
      '<datalist id="bookopts">' + opts + '</datalist>' +
      '<label class="lbl">正面（问题）</label>' +
      '<textarea id="f-q" class="inp area" placeholder="要背的内容，如：复利现值公式？"></textarea>' +
      '<label class="lbl">背面（答案）</label>' +
      '<textarea id="f-a" class="inp area" placeholder="答案内容"></textarea>' +
      '<button class="btn primary" data-act="add">保存这张卡片</button>' +
      '</div>' +
      '<div class="card">' +
      '<details><summary class="bat">批量粘贴（每行一张：问题||答案）</summary>' +
      '<textarea id="f-batch" class="inp area" placeholder="资本资产定价模型||CAPM\n有效市场假说||EMH"></textarea>' +
      '<button class="btn" data-act="batch">批量导入（用上方“所属书”归类）</button>' +
      '</details>' +
      '</div>' +
      '<div class="card">' +
      '<div class="bat">文件导入（txt / md / docx / pdf）</div>' +
      '<p class="hint">先选文档，显示原文后你可以手动编辑、选中，再一键拆成卡片。</p>' +
      '<button class="btn" data-act="import-file">选择文件导入</button>' +
      '<input type="file" id="f-file" accept=".txt,.md,.docx,.pdf" hidden>' +
      '</div>' +
      '<p class="hint">已收录 ' + state.cards.length + ' 张卡片。</p>';
    var finp = $('f-file');
    if (finp) finp.onchange = function (ev) { if (ev.target.files && ev.target.files[0]) startImport(ev.target.files[0]); };
  }

  // 复习/模考共用的卡片渲染：挖空卡渲染 N 个输入框，显示答案后回填正确答案
  function flipCard(card, revealed) {
    if (card.cloze && card.points && card.points.length) {
      var inputs = card.points.map(function (p, i) {
        return '<div class="cl"><span class="cn">' + circled(i + 1) + '</span>' +
          '<input class="clin" value="' + (revealed ? esc(p) : '') + '" placeholder="回想第 ' + (i + 1) + ' 点…" ' + (revealed ? 'readonly' : '') + '></div>';
      }).join('');
      return '<div class="card flip"><div class="q">' + esc(card.q) + '</div>' +
        '<div class="cloze">' + inputs + '</div>' +
        (revealed ? '<div class="a">' + esc(card.a || '') + '</div>' : '') + '</div>';
    }
    return '<div class="card flip"><div class="q">' + esc(card.q) + '</div>' +
      (revealed ? '<div class="a">' + esc(card.a || '(无答案)') + '</div>' : '') + '</div>';
  }

  function viewReview() {
    if (!reviewQueue) reviewQueue = dueCards();
    if (!reviewQueue || reviewQueue.length === 0) {
      viewEl.innerHTML = '<div class="card center"><div class="big">🎉</div>' +
        '<p>当前没有待复习的卡片。</p>' +
        (state.cards.length ? '<button class="btn primary" data-act="review-all">复习全部卡片</button>' : '') + '</div>';
      return;
    }
    var card = reviewQueue[0];
    var revealed = !!card._revealed;
    var nextHint = '';
    if (card.lastGrade) {
      var lastTxt = card.lastGrade === 5 ? '上次：认识' : card.lastGrade === 3 ? '上次：模糊' : '上次：忘记';
      nextHint = '<p class="hint">' + lastTxt + ' · 熟悉度 ' + familiarity(card) + '%</p>';
    }
    viewEl.innerHTML =
      '<div class="prog">待复习 ' + reviewQueue.length + ' 张</div>' +
      flipCard(card, revealed) +
      nextHint +
      (revealed
        ? '<div class="row3">' +
        '<button class="btn r-forget" data-act="grade" data-arg="1">忘记 ✗</button>' +
        '<button class="btn r-fuzzy" data-act="grade" data-arg="3">模糊</button>' +
        '<button class="btn good" data-act="grade" data-arg="5">认识 ✓</button>' +
        '</div>'
        : '<button class="btn primary" data-act="reveal">显示答案</button>');
  }

  function viewExam() {
    if (!exam) {
      viewEl.innerHTML = '<div class="card center"><p>从你的卡片里随机抽题自测，每套最多 10 题。</p>' +
        '<button class="btn primary" data-act="exam-start">开始模拟考</button></div>';
      return;
    }
    if (exam.idx >= exam.queue.length) {
      var score = exam.queue.length ? Math.round(exam.score / exam.queue.length * 100) : 0;
      viewEl.innerHTML = '<div class="card center"><div class="big">' + score + ' 分</div>' +
        '<p>答对 ' + exam.score + ' / ' + exam.queue.length + '</p>' +
        '<button class="btn primary" data-act="exam-restart">再来一次</button></div>';
      return;
    }
    var card = exam.queue[exam.idx];
    viewEl.innerHTML =
      '<div class="prog">第 ' + (exam.idx + 1) + ' / ' + exam.queue.length + ' 题　得分 ' + exam.score + '</div>' +
      flipCard(card, exam.revealed) +
      (exam.revealed
        ? '<div class="row2"><button class="btn bad" data-act="exam-wrong">答错了 ✗</button>' +
        '<button class="btn good" data-act="exam-correct">答对了 ✓</button></div>'
        : '<button class="btn primary" data-act="reveal">显示答案</button>');
  }

  function viewCheckin() {
    var today = todayStr();
    var done = state.checkins.indexOf(today) >= 0;
    var st = streak();
    var dots = '';
    var d = new Date();
    for (var i = 6; i >= 0; i--) {
      var dd = new Date(d); dd.setDate(d.getDate() - i);
      var s = dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate());
      var on = state.checkins.indexOf(s) >= 0;
      dots += '<span class="dot ' + (on ? 'on' : '') + '">' + (on ? '●' : '○') + '</span>';
    }
    viewEl.innerHTML =
      '<div class="card center">' +
      '<div class="streak">' + st + '</div><div class="sub">连续签到天数</div>' +
      '<div class="dots">' + dots + '</div>' +
      (done ? '<button class="btn" disabled>今日已签到 ✓</button>'
        : '<button class="btn primary" data-act="checkin">今日签到</button>') +
      '<p class="hint">累计签到 ' + state.checkins.length + ' 天</p>' +
      '</div>';
  }

  function viewLibrary() {
    var books = bookList();
    if (books.length === 0) {
      viewEl.innerHTML = '<div class="card center"><p>还没有任何书。</p>' +
        '<p class="hint">去「录入」加第一张卡片，会自动归到对应的书。</p></div>';
      return;
    }
    var rows = books.map(function (b) {
      var cnt = 0;
      state.cards.forEach(function (c) { if (c.book === b) cnt++; });
      return '<div class="librow"><div class="libname">' + esc(b) + ' <span class="cnt">' + cnt + '</span></div>' +
        '<div class="libact"><button class="btn small" data-act="review-book" data-arg="' + esc(b) + '">复习</button>' +
        '<button class="btn small ghost" data-act="del-book" data-arg="' + esc(b) + '">删</button></div></div>';
    }).join('');
    viewEl.innerHTML = '<div class="card">' + rows + '</div>' +
      '<p class="hint">共 ' + state.cards.length + ' 张卡片，' + books.length + ' 本书。</p>';
  }

  function viewMine() {
    var gc = ghCfg() || {};
    var total = state.cards.length;
    var books = bookList().length;
    var due = dueCards().length;
    // 复习分布
    var now = Date.now();
    var t0 = 0, t1 = 0, t27 = 0, t7 = 0;
    state.cards.forEach(function (c) {
      var days = Math.ceil(((c.due || 0) - now) / DAY);
      if (days <= 0) t0++;
      else if (days === 1) t1++;
      else if (days <= 7) t27++;
      else t7++;
    });
    var dist = '<div class="dist">' +
      '<div class="dcell"><b>' + t0 + '</b><span>今天</span></div>' +
      '<div class="dcell"><b>' + t1 + '</b><span>明天</span></div>' +
      '<div class="dcell"><b>' + t27 + '</b><span>2-7天</span></div>' +
      '<div class="dcell"><b>' + t7 + '</b><span>7天+</span></div>' +
      '</div>';

    var th = THEMES.map(function (t) {
      var sw = t.img
        ? '<img class="sw" src="' + esc(t.img) + '" alt="" loading="lazy">'
        : '<span class="sw noimg" style="background:var(--primary)">' + (t.icon || '') + '</span>';
      return '<div class="theme ' + (t.key === state.theme ? 'cur' : '') + '" data-act="theme" data-arg="' + t.key + '">' +
        sw + '<span>' + esc(t.name) + '</span></div>';
    }).join('');

    var curve = buildCurveSVG();

    viewEl.innerHTML =
      '<div class="card stats"><div><b>' + total + '</b><span>卡片</span></div>' +
      '<div><b>' + books + '</b><span>书</span></div>' +
      '<div><b>' + due + '</b><span>待复习</span></div>' +
      '<div><b>' + state.checkins.length + '</b><span>签到</span></div></div>' +
      '<div class="card"><div class="lbl">复习分布（按下次复习时间）</div>' + dist + '</div>' +
      '<div class="card"><div class="lbl">遗忘曲线（越往右越容易忘，点「认识」会推远复习点）</div>' + curve + '</div>' +
      '<div class="card"><div class="lbl">主题（点一下立刻换，选择会记住）</div><div class="themes">' + th + '</div></div>' +
      '<div class="card">' +
      '<button class="btn" data-act="export">导出备份(JSON)</button>' +
      '<button class="btn" data-act="import">导入备份</button>' +
      '<input type="file" id="importer" accept=".json,application/json" hidden>' +
      '</div>' +
      '<div class="card">' +
      '<div class="lbl">AI 解析配置（可选）</div>' +
      '<p class="hint">填入 OpenAI 兼容接口后，文件导入可调用 AI 自动拆题。不填则走本地智能解析。</p>' +
      '<label class="lbl">接口地址</label>' +
      '<input id="ai-url" class="inp" placeholder="https://api.openai.com/v1/chat/completions" value="' + esc(state.ai.url) + '">' +
      '<label class="lbl">API Key</label>' +
      '<input id="ai-key" type="password" class="inp" placeholder="sk-..." value="' + esc(state.ai.key) + '">' +
      '<label class="lbl">模型</label>' +
      '<input id="ai-model" class="inp" placeholder="gpt-4o-mini" value="' + esc(state.ai.model) + '">' +
      '<button class="btn primary" data-act="save-ai">保存 AI 配置</button>' +
      '</div>' +
      '<div class="card">' +
      '<div class="lbl">云端同步（GitHub，可选）</div>' +
      '<p class="hint">填入你的 GitHub 个人访问令牌（PAT，需 repo 权限）后，数据会<b>自动备份到你私有仓库</b>，手机在外也能拉取。令牌只存在本机，不会写入代码。</p>' +
      '<label class="lbl">GitHub 用户名</label>' +
      '<input id="gh-user" class="inp" placeholder="如 appleagainjie" value="' + esc(gc.user || 'appleagainjie') + '">' +
      '<label class="lbl">数据仓库名（私人仓库，已为你建好）</label>' +
      '<input id="gh-repo" class="inp" placeholder="beiji-data" value="' + esc(gc.repo || 'beiji-data') + '">' +
      '<label class="lbl">个人访问令牌 PAT（需 repo 权限）</label>' +
      '<input id="gh-token" type="password" class="inp" placeholder="ghp_... 或 github_pat_...">' +
      '<p class="hint">数据账户名取自你的登录账号：<b>' + esc(currentAccount || (localAuthGet() && localAuthGet().account) || '（未登录）') + '</b>，无需在此填。</p>' +
      '<div class="ghbtns"><button class="btn primary" data-act="save-gh">保存云端配置</button>' +
      '<button class="btn" data-act="test-gh">测试连接</button>' +
      '<button class="btn" data-act="backup-gh">立即备份</button></div>' +
      '<p class="hint" id="gh-status"></p>' +
      '</div>' +
      ((MODE === 'github' && ghCfg() && ghCfg().token)
        ? '<p class="hint">✅ 云端同步已开启：数据自动存到你的 GitHub 私有仓库（账户：' + esc(ghCfg() ? ghCfg().account : '') + '），手机在外也能拉取，本地也保留一份兜底。</p>'
        : MODE === 'server'
        ? '<p class="hint">数据存在本机 E 盘文件里（账户：' + esc(session.username) + '），清浏览器缓存也不会丢。换设备需重新登录同一账户。</p>'
        : '<p class="hint">当前为单人模式，数据存在这台设备的浏览器里。换手机、清缓存会丢，记得常导出备份，或去上方开启 GitHub 云端同步。</p>');
    var imp = $('importer');
    if (imp) imp.onchange = function () { if (imp.files && imp.files[0]) importData(imp.files[0]); };
  }

  // 内联 SVG 遗忘曲线（Ebbinghaus：R(t)=e^(-t/S)，S 与平均 ef 相关）
  function buildCurveSVG() {
    var W = 300, H = 150, padL = 28, padB = 22, padT = 10, padR = 8;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxT = 30; // 天数
    var cards = state.cards;
    var avgEf = 2.5;
    if (cards.length) {
      var sum = 0; cards.forEach(function (c) { sum += c.ef; });
      avgEf = sum / cards.length;
    }
    var S = avgEf * 2.2; // 稳定度系数（天）
    function rt(t) { return Math.exp(-t / S); }
    function X(t) { return padL + t / maxT * plotW; }
    function Y(r) { return padT + (1 - r) * plotH; }
    // 曲线
    var pts = [];
    for (var t = 0; t <= maxT; t += 1) pts.push(X(t).toFixed(1) + ',' + Y(rt(t)).toFixed(1));
    var path = pts.join(' ');
    // 下次复习点
    var now = Date.now();
    var marks = '';
    cards.forEach(function (c) {
      var days = Math.round(((c.due || 0) - now) / DAY);
      if (days < 0) days = 0; if (days > maxT) return;
      var r = rt(days);
      marks += '<circle cx="' + X(days).toFixed(1) + '" cy="' + Y(r).toFixed(1) + '" r="2.6" fill="var(--primary)"/>';
    });
    var grid = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (g) {
      var y = Y(g);
      grid += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="#e3e3e3" stroke-width="1"/>';
      grid += '<text x="2" y="' + (y + 3).toFixed(1) + '" font-size="8" fill="#999">' + Math.round(g * 100) + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block">' +
      grid +
      '<polyline points="' + path + '" fill="none" stroke="var(--primary)" stroke-width="2"/>' +
      marks +
      '<text x="' + (W - padR - 2) + '" y="' + (H - 4) + '" font-size="8" fill="#999" text-anchor="end">天 →</text>' +
      '</svg>';
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    handle(t.dataset.act, t.dataset.arg, t);
  }
  function handle(act, arg, t) {
    if (act === 'tab') { show(arg); return; }

    if (act === 'add') {
      var book = val('f-book').trim();
      var q = val('f-q').trim();
      var a = val('f-a').trim();
      if (!q || !a) { toast('问题和答案都要填'); return; }
      state.cards.push(newCard(book, q, a));
      save();
      toast('已添加 ✓');
      setVal('f-q', ''); setVal('f-a', '');
      var h = viewEl.querySelector('.hint'); if (h) h.textContent = '已收录 ' + state.cards.length + ' 张卡片。';
      return;
    }

    if (act === 'batch') {
      var bbook = val('f-book').trim();
      var lines = val('f-batch').split(/\n+/);
      var n = 0;
      lines.forEach(function (line) {
        line = line.trim(); if (!line) return;
        var parts = line.split(/\s*\|\|\s*|\s*----\s*|\s*——\s*/);
        var q, a;
          if (parts.length >= 2) { q = parts[0].trim(); a = parts[1].trim(); }
        else {
          var m = line.match(/问[：:]\s*([\s\S]*?)\s*答[：:]\s*([\s\S]*)/);
          if (m) { q = m[1].trim(); a = m[2].trim(); } else { q = line; a = ''; }
        }
        if (q) { state.cards.push(newCard(bbook, q, a)); n++; }
      });
      if (n) { save(); toast('已导入 ' + n + ' 张'); setVal('f-batch', '');
        var h = viewEl.querySelector('.hint'); if (h) h.textContent = '已收录 ' + state.cards.length + ' 张卡片。';
      } else toast('没识别到内容');
      return;
    }

    if (act === 'import-file') { var finp = $('f-file'); if (finp) finp.click(); return; }

    if (act === 'parse-preview') { importState.mode = arg; smartParse(); return; }
    if (act === 'ai-parse') { aiParse(); return; }
    if (act === 'ai-go') { closeImportModal(); show('mine'); return; }
    if (act === 'confirm-import') { confirmImport(); return; }
    if (act === 'close-overlay') { closeImportModal(); return; }
    if (act === 'save-ai') {
      state.ai.url = val('ai-url').trim();
      state.ai.key = val('ai-key').trim();
      state.ai.model = val('ai-model').trim() || 'gpt-4o-mini';
      save(); toast('AI 配置已保存'); return;
    }
    if (act === 'save-gh') {
      var guser = val('gh-user').trim(), grepo = val('gh-repo').trim(), gtoken = val('gh-token').trim();
      var gs = $('gh-status');
      if (!guser || !grepo || !gtoken) { if (gs) gs.textContent = '用户名、仓库名、令牌都要填'; toast('请填完整'); return; }
      var cur = currentAccount || (localAuthGet() && localAuthGet().account) || '默认账户';
      setGhCfg({ user: guser, repo: grepo, token: gtoken, account: cur });
      MODE = 'github';
      toast('已保存云端配置，正在从 GitHub 载入该账户数据…');
      loadData().then(enterApp);
      return;
    }
    if (act === 'test-gh') {
      var c = ghCfg(); var gs2 = $('gh-status');
      if (!c || !c.token) { if (gs2) gs2.textContent = '请先填并保存配置'; return; }
      ghLoad().then(function (d) { if (gs2) gs2.textContent = '连接成功，云端该账户已有 ' + (d.cards ? d.cards.length : 0) + ' 张卡片'; })
        .catch(function (e) { if (gs2) gs2.textContent = '连接失败：' + e.message; });
      return;
    }
    if (act === 'backup-gh') {
      var c2 = ghCfg();
      if (!c2 || !c2.token) { toast('请先在「云端同步」里填配置'); return; }
      toast('正在备份到 GitHub…');
      ghSave(state).then(function () { toast('已备份到 GitHub ✓'); });
      return;
    }

    if (act === 'reveal') {
      if (exam) exam.revealed = true;
      else if (reviewQueue && reviewQueue[0]) reviewQueue[0]._revealed = true;
      render(); return;
    }

    if (act === 'grade') {
      if (!reviewQueue || !reviewQueue[0]) return;
      var card = reviewQueue[0];
      var q = parseInt(arg, 10);
      grade(card, q);
      card._revealed = false;
      if (q < 3) {
        // 忘记：移到队列末尾，本轮再出现
        reviewQueue.push(reviewQueue.shift());
      } else {
        reviewQueue.shift();
        if (reviewQueue.length === 0) reviewQueue = null;
      }
      save();
      render(); return;
    }

    if (act === 'review-all') { reviewQueue = state.cards.slice(); render(); return; }
    if (act === 'review-book') {
      reviewQueue = state.cards.filter(function (c) { return c.book === arg; });
      if (!reviewQueue.length) { toast('这本书还没有卡片'); reviewQueue = null; return; }
      show('review'); return;
    }
    if (act === 'del-book') {
      if (!confirm('删除《' + arg + '》及其所有卡片？此操作不可恢复')) return;
      state.cards = state.cards.filter(function (c) { return c.book !== arg; });
      save(); toast('已删除《' + arg + '》'); render(); return;
    }

    if (act === 'exam-start') {
      if (!state.cards.length) { toast('先去录入一些卡片'); return; }
      var pool = state.cards.slice();
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      var cnt = Math.min(10, pool.length);
      exam = { queue: pool.slice(0, cnt), idx: 0, score: 0, revealed: false };
      render(); return;
    }
    if (act === 'exam-correct') { exam.score++; exam.idx++; exam.revealed = false; render(); return; }
    if (act === 'exam-wrong') { exam.idx++; exam.revealed = false; render(); return; }
    if (act === 'exam-restart') { exam = null; render(); return; }

    if (act === 'checkin') {
      var tday = todayStr();
      if (state.checkins.indexOf(tday) < 0) { state.checkins.push(tday); save(); toast('签到成功 ✓'); render(); }
      return;
    }

    if (act === 'theme') { state.theme = arg; save(); applyTheme(); render(); return; }

    if (act === 'export') { exportData(); return; }
    if (act === 'import') {
      var inp = $('importer'); if (!inp) return;
      inp.onchange = function () { if (inp.files && inp.files[0]) importData(inp.files[0]); };
      inp.click(); return;
    }
  }

  /* ---------- 文件导入 ---------- */
  function startImport(file) {
    toast('正在读取文件…');
    extractText(file).then(function (text) {
      importState = { text: text, mode: 'auto', preview: [], book: val('f-book').trim() };
      openImportModal();
      // 打开后自动跑本地智能解析（即时、免费、离线可用）
      setTimeout(function () { smartParse(); }, 50);
      // 若已配置 AI，自动用 AI 重新解析升级结果（失败则保留本地结果）
      if (state.ai.url && state.ai.key) {
        setTimeout(function () { aiParse(); }, 450);
      }
    }).catch(function (err) { toast('读取失败：' + err); });
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject('加载脚本失败：' + src); };
      document.head.appendChild(s);
    });
  }
  function extractText(file) {
    return new Promise(function (resolve, reject) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      if (['txt', 'md'].indexOf(ext) >= 0) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject('文本读取失败'); };
        r.readAsText(file);
      } else if (ext === 'docx') {
        extractDocx(file).then(resolve).catch(function (e) { reject('docx 解析失败：' + e); });
        return;
      } else if (ext === 'pdf') {
        var ver = '3.11.174';
        loadScript('https://unpkg.com/pdfjs-dist@' + ver + '/build/pdf.min.js').then(function () {
          if (typeof pdfjsLib !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@' + ver + '/build/pdf.worker.min.js';
          var r = new FileReader();
          r.onload = function () {
            pdfjsLib.getDocument({ data: new Uint8Array(r.result) }).promise.then(function (pdf) {
              var pages = new Array(pdf.numPages); var done = 0;
              for (var i = 1; i <= pdf.numPages; i++) {
                pdf.getPage(i).then(function (page) {
                  page.getTextContent().then(function (tc) {
                    pages[page.pageNumber - 1] = tc.items.map(function (it) { return it.str; }).join(' ');
                    done++;
                    if (done === pdf.numPages) resolve(pages.join('\n'));
                  });
                });
              }
            }).catch(function (e) { reject('pdf 解析失败'); });
          };
          r.onerror = function () { reject('pdf 读取失败'); };
          r.readAsArrayBuffer(file);
        }).catch(function (e) { reject(e); });
      } else { reject('不支持的格式：' + ext); }
    });
  }
  // docx：优先用 JSZip 直接读 document.xml，把“高亮/标色”的文字标记为【重点】，
  // 其余（含 ①②③ 序号）原样保留；任一环节失败都退回 mammoth 纯文本，保证可用。
  function extractDocx(file) {
    return new Promise(function (resolve, reject) {
      var doMammoth = function () {
        loadScript('https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js').then(function () {
          var r = new FileReader();
          r.onload = function () {
            mammoth.extractRawText({ arrayBuffer: r.result }).then(function (res) { resolve(res.value); })
              .catch(function () { reject('docx 解析失败'); });
          };
          r.onerror = function () { reject('docx 读取失败'); };
          r.readAsArrayBuffer(file);
        }).catch(function (e) { reject(e); });
      };
      var rich = function () {
        if (typeof JSZip === 'undefined') { doMammoth(); return; }
        var r = new FileReader();
        r.onload = function () {
          JSZip.loadAsync(r.result).then(function (zip) {
            var f = zip.file('word/document.xml');
            if (!f) { doMammoth(); return; }
            f.async('string').then(function (xml) {
              try {
                var doc = new DOMParser().parseFromString(xml, 'text/xml');
                var paras = doc.getElementsByTagName('w:p');
                var out = [];
                for (var p = 0; p < paras.length; p++) {
                  var runs = paras[p].getElementsByTagName('w:r');
                  var line = '';
                  for (var rr = 0; rr < runs.length; rr++) {
                    var run = runs[rr];
                    var txt = '';
                    var ts = run.getElementsByTagName('w:t');
                    for (var tt = 0; tt < ts.length; tt++) txt += ts[tt].textContent;
                    if (!txt) continue;
                    line += runIsKey(run) ? '\uE000' + txt + '\uE001' : txt;
                  }
                  if (line.trim()) out.push(line.trim());
                }
                if (!out.length) { doMammoth(); return; }
                resolve(out.join('\n'));
              } catch (e) { doMammoth(); }
            }).catch(function () { doMammoth(); });
          }).catch(function () { doMammoth(); });
        };
        r.onerror = function () { reject('docx 读取失败'); };
        r.readAsArrayBuffer(file);
      };
      if (typeof JSZip === 'undefined') {
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js').then(rich).catch(doMammoth);
      } else { rich(); }
    });
  }
  function runIsKey(run) {
    var hl = run.getElementsByTagName('w:highlight');
    if (hl.length) { var v = hl[0].getAttribute('w:val'); if (v && v !== 'none' && v !== 'false') return true; }
    var cols = run.getElementsByTagName('w:color');
    if (cols.length) { var c = (cols[0].getAttribute('w:val') || '').toLowerCase(); if (c && c !== '000000' && c !== 'auto') return true; }
    return false;
  }

  function openImportModal() {
    if (!overlayEl) return;
    renderImportModal();
    overlayEl.classList.remove('hidden'); overlayEl.classList.add('show');
  }
  function closeImportModal() {
    if (!overlayEl) return;
    overlayEl.classList.remove('show');
    setTimeout(function () { overlayEl.classList.add('hidden'); }, 250);
  }
  function renderImportModal() {
    var aiOk = !!(state.ai.url && state.ai.key);
    var previewHTML = '';
    if (importState.preview.length > 0) {
      previewHTML = '<div class="preview">' +
        importState.preview.map(function (it, idx) {
          return '<div class="item"><div class="q">' + (idx + 1) + '. ' + esc(it.q) + '</div><div class="a">' + esc(it.a) + '</div></div>';
        }).join('') + '</div>';
    } else {
      previewHTML = '<p class="hint warn">本地智能解析没自动识别出问答结构（原文可能是纯段落、没有题号 / 问号 / 答案标记）。你可以：<br>① 点上方「知识点模式」试试；<br>② 在原文里用 <b>问题||答案</b> 或 <b>问：…答：…</b> 手动标一下；<br>③ 直接手填题干和答案。</p>';
    }
    overlayEl.innerHTML =
      '<div class="sheet">' +
      '<div class="sh"><h3>文档导入</h3><button class="close" data-act="close-overlay">×</button></div>' +
      '<div class="body">' +
      '<label class="lbl">归入书目（可选）</label>' +
      '<input id="imp-book" class="inp" value="' + esc(importState.book) + '" placeholder="如：中级会计">' +
      '<label class="lbl">原文（可直接编辑、选中你要的部分）</label>' +
      '<textarea id="raw-text" class="raw">' + esc(importState.text) + '</textarea>' +
      '<div class="mode">' +
      '<button class="btn small ' + (importState.mode === 'qa' ? 'on' : '') + '" data-act="parse-preview" data-arg="qa">题库：拆问答</button>' +
      '<button class="btn small ' + (importState.mode === 'knowledge' ? 'on' : '') + '" data-act="parse-preview" data-arg="knowledge">知识点：标题+正文</button>' +
      '<button class="btn small ' + (importState.mode === 'cloze' ? 'on' : '') + '" data-act="parse-preview" data-arg="cloze">挖空默写：标题+要点</button>' +
      '</div>' +
      (aiOk
        ? '<button class="btn primary" data-act="ai-parse">🤖 AI 再精修一遍（已配置）</button>'
        : '<button class="btn ghost" data-act="ai-go">🤖 想让 AI 再精修？在「我的」填接口（不填也能用）</button>') +
      '<p class="hint">✅ 已用<b>本地智能解析</b>自动识别（无需 AI、无需联网），结果在下方预览，可直接编辑校正后再导入。' +
      (importState.mode === 'qa' ? '本次识别为：题库模式·拆问答。'
        : importState.mode === 'cloze' ? '本次识别为：挖空默写·标题 + 要点（①②③ / 高亮 / 标色 自动变填空）。'
        : '本次识别为：知识点模式·标题+正文。') + '</p>' +
      previewHTML +
      '</div>' +
      '<div class="foot">' +
      '<button class="btn ghost" data-act="close-overlay">取消</button>' +
      '<button class="btn primary" data-act="confirm-import">确认导入 ' + importState.preview.length + ' 张</button>' +
      '</div>' +
      '</div>';
  }
  function smartParse() {
    var text = val('raw-text');
    var mode = importState.mode;
    if (mode === 'auto') mode = detectMode(text);
    importState.mode = mode;
    var items = mode === 'qa' ? parseQA(text) : mode === 'cloze' ? parseCloze(text) : parseKnowledge(text);
    importState.preview = items;
    renderImportModal();
  }
  function classifyLine(line) {
    if (/^答案[：:\s]|^【答案】[：:\s]*|^[答][：:\s]+/.test(line)) return 'answer';
    if (/^[A-Da-d][\.．、]\s*\S+/.test(line) && line.length < 80) return 'option';
    if (/^(?:\d+)[\.．、]\s*.+[？?？]/.test(line)) return 'question';
    if (/^[（(]\d+[）)]\s*.+[？?？]/.test(line)) return 'subquestion';
    if (/^\d+[\.．、]\s*(?:简述|论述|说明|分析|计算|名词解释|比较|评价|概述|列举|试述|试论)/.test(line)) return 'question';
    if (/^[（(]\d+[）)]\s*(?:简述|论述|说明|分析|计算|名词解释|比较|评价|概述|列举|试述|试论)/.test(line)) return 'subquestion';
    if (/^[一二三四五六七八九十]+[、．.]/.test(line) && /[？?？]|简述|论述|说明|分析|计算|名词解释/.test(line) && line.length < 60) return 'question';
    if (/^问[：:]/.test(line)) return 'question';
    if (/[？?？]$/.test(line)) return 'question';
    if (/某.+项目|案例|根据以下|如下|背景材料|阅读材料/.test(line)) return 'case';
    return 'text';
  }
  /* ---------- 挖空默写模式 ---------- */
  // 把带圈/阿拉伯/中文序号的要点，或文档里被高亮、标色的重点，自动变成“填空题”
  var CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  function circled(n) { return (n >= 1 && n <= 20) ? CIRCLED.charAt(n - 1) : '(' + n + ')'; }

  // 按分隔标记把一行拆成若干“要点”文本
  function splitByMarkers(line, re) {
    var ms = [], m; re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) { ms.push(m); if (m.index === re.lastIndex) re.lastIndex++; }
    if (!ms.length) return [];
    var pts = [];
    for (var k = 0; k < ms.length; k++) {
      var start = ms[k].index + ms[k][0].length;
      var end = (k + 1 < ms.length) ? ms[k + 1].index : line.length;
      var seg = line.slice(start, end).replace(/^[、．.\s]+/, '').replace(/\s+$/, '');
      if (seg) pts.push(seg);
    }
    return pts;
  }
  // 文档重点标记（由 JSZip 抓高亮/颜色时包裹：\uE000 文本 \uE001）
  function extractKeySegments(text) {
    var segs = [], re = /\uE000([\s\S]*?)\uE001/g, m;
    while ((m = re.exec(text)) !== null) { var s = m[1].trim(); if (s) segs.push(s); }
    return segs;
  }
  // 识别一行里的若干要点（支持 ①②③、1. 2. 3.、(1)(2)、一二三、以及高亮段）
  function countPoints(line) {
    var pts;
    pts = splitByMarkers(line, /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g); if (pts.length >= 2) return pts;
    pts = splitByMarkers(line, /(?:\d+)[.．、]/g); if (pts.length >= 2) return pts;
    pts = splitByMarkers(line, /（\d+）|(\(\d+\))/g); if (pts.length >= 2) return pts;
    pts = splitByMarkers(line, /[一二三四五六七八九十]+[、．.]/g); if (pts.length >= 2) return pts;
    pts = extractKeySegments(line); if (pts.length >= 1) return pts;
    return [];
  }
  // 往前找最近的“标题行”作为这张挖空卡的题干
  function findHeading(paras, i) {
    var headPat = /^\d+[.、]|^[一二三四五六七八九十]+[、．.]|^（[一二三四五六七八九十]+）/;
    var tailPat = /(特征|含义|因素|理论|模型|观|论|内容|指标|途径|原因|条件|关系|概念|辨析|措施|定义|阶段|类型|方式|表现|实质|内容)$/;
    for (var j = i - 1; j >= 0; j--) {
      var s = paras[j];
      if (countPoints(s).length >= 2) continue;   // 跳过要点行本身
      if (extractKeySegments(s).length) continue;
      if (headPat.test(s) || tailPat.test(s) || s.length <= 22) return s;
    }
    return '';
  }
  function makeCloze(heading, pts) {
    var h = heading ? heading + '\n' : '';
    var q = h + '（共 ' + pts.length + ' 个要点，先自己默写，再点「显示答案」核对）';
    var a = h + pts.map(function (p, idx) { return circled(idx + 1) + p; }).join('');
    return { q: q, a: a, cloze: true, points: pts };
  }
  function parseCloze(text) {
    // 去掉段落开头的项目符号字形，按空行/换行切段
    var paras = text.replace(/\r/g, '').split(/\n+/).map(function (s) {
      return s.replace(/^[•·▪\-–—\s]+/, '').trim();
    }).filter(Boolean);
    var items = [];
    for (var i = 0; i < paras.length; i++) {
      var line = paras[i];
      var pts = countPoints(line);
      if (pts.length < 2) pts = extractKeySegments(line).length ? extractKeySegments(line) : [];
      if (pts.length >= 2) {
        items.push(makeCloze(findHeading(paras, i), pts));
      } else if (pts.length === 1) {
        // 单行单要点：若附近有标题，也成一张卡
        var hd = findHeading(paras, i);
        if (hd) items.push(makeCloze(hd, pts));
      }
    }
    return items;
  }

  function detectMode(text) {
    var qa = 0, know = 0, cloze = 0;
    if (/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/.test(text)) cloze += 3;
    if ((text.match(/（\d+）/g) || []).length >= 2) cloze += 2;
    if ((text.match(/\([1-9]\d?\)/g) || []).length >= 2) cloze += 2;
    if (/答案[：:\s]/.test(text)) qa += 3;
    if (/[A-Da-d][\.．、]/.test(text)) qa += 2;
    if (/\d+[\.．、].+[？?？]/.test(text)) qa += 2;
    if (/问[：:]/.test(text)) qa += 1;
    if (/^#{1,6}\s/m.test(text)) know += 3;
    if (/^([一二三四五六七八九十]+)[、．.]\s*\S+$/m.test(text)) know += 2;
    if (cloze >= 3) return 'cloze';
    return qa >= know ? 'qa' : 'knowledge';
  }
  function parseQA(text) {
    var rawLines = text.split(/\r?\n/);
    var lines = [];
    rawLines.forEach(function (l) { l = l.trim(); if (l) lines.push(l); });

    var items = [];
    // 1) 显式分隔：问题||答案 或 问：...答：...
    var hasSep = false;
    lines.forEach(function (line) {
      var sep = line.indexOf('||');
      if (sep >= 0) { hasSep = true; items.push({ q: line.slice(0, sep).trim(), a: line.slice(sep + 2).trim() }); return; }
      var m = line.match(/^问[：:]\s*([\s\S]+?)\s*答[：:]\s*([\s\S]+)$/);
      if (m) { hasSep = true; items.push({ q: m[1].trim(), a: m[2].trim() }); }
    });
    if (hasSep && items.length) return items.filter(function (it) { return it.q; });

    // 2) 智能题库解析
    var cls = lines.map(function (line) { return { raw: line, type: classifyLine(line) }; });
    // 把“答案：...”行绑定到离它最近的前一个问题（按答案行自身下标存）
    var ansFor = {};
    for (var i = 0; i < cls.length; i++) {
      if (cls[i].type === 'answer') {
        var ans = cls[i].raw.replace(/^答案[：:\s]+|^【答案】[：:\s]*|^[答][：:\s]+/, '').trim();
        for (var j = i - 1; j >= 0; j--) {
          if (cls[j].type === 'question' || cls[j].type === 'subquestion' || cls[j].type === 'case') { ansFor[i] = ans; break; }
        }
      }
    }

    var q = null, aBuf = [], opts = [];
    function flush() {
      if (!q) return;
      var ans = aBuf.join('\n').trim();
      var body;
      if (opts.length) body = opts.join('\n') + (ans ? '\n答案：' + ans : '');
      else body = ans;
      items.push({ q: q, a: body || '(无答案)' });
      q = null; aBuf = []; opts = [];
    }
    for (var i = 0; i < cls.length; i++) {
      var c = cls[i];
      if (c.type === 'answer') {
        if (ansFor[i]) aBuf.push(ansFor[i]);
        continue;
      }
      if (c.type === 'question' || c.type === 'subquestion') {
        flush(); q = c.raw;
      } else if (c.type === 'case') {
        flush(); q = c.raw;
      } else if (c.type === 'option') {
        if (q) opts.push(c.raw); else { q = '(选择题)'; opts.push(c.raw); }
      } else {
        if (q) aBuf.push(c.raw); else q = c.raw;
      }
    }
    flush();
    return items.filter(function (it) { return it.q; });
  }
  function parseKnowledge(text) {
    var lines = text.split(/\r?\n/); var items = []; var q = null, a = [];
    function flush() { if (q) { items.push({ q: q, a: (a.join('\n').trim()) || '(无内容)' }); q = null; a = []; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim(); if (!line) continue;
      var h = line.match(/^(#{1,6})\s*(.+)$/);
      if (h) { flush(); q = h[2].trim(); continue; }
      if (/^\*\*[^*]+\*\*$/.test(line) || /^「[^」]+」$/.test(line)) { flush(); q = line.replace(/^\*\*|\*\*$/g, '').replace(/[「」]/g, ''); continue; }
      if (/^([一二三四五六七八九十]+|\d+)[、．.]\s*\S+$/.test(line) && line.length <= 40 && i + 1 < lines.length && lines[i + 1].trim().length > line.length) { flush(); q = line; continue; }
      if (!q && line.length <= 30 && !/[。，；：,;：]$/.test(line) && i + 1 < lines.length && lines[i + 1].trim()) { q = line; continue; }
      if (q) a.push(line); else q = line;
    }
    flush();
    return items.filter(function (it) { return it.q; });
  }
  function aiParse() {
    if (!state.ai.url || !state.ai.key) { toast('AI 未配置'); return; }
    var text = val('raw-text').trim(); if (!text) { toast('原文为空'); return; }
    toast('AI 解析中…');
    var prompt = '请把下面的学习资料拆成若干张记忆卡片。每张卡片包含一个问题（q）和一个答案（a）。' +
      '如果是题库，尽量拆成“题干+答案”；如果是知识点，拆成“核心概念+详细解释”。' +
      '只返回 JSON 数组，格式：[{"q":"...","a":"..."},...]，不要任何解释、不要 Markdown 代码块。';
    fetch(state.ai.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.ai.key },
      body: JSON.stringify({ model: state.ai.model || 'gpt-4o-mini', messages: [{ role: 'system', content: prompt }, { role: 'user', content: text }], temperature: 0.2 })
    }).then(function (res) { return res.text(); }).then(function (raw) {
      var jsonText = raw;
      try { var parsed = JSON.parse(raw); if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) jsonText = parsed.choices[0].message.content; } catch (e) {}
      jsonText = jsonText.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      var arr = JSON.parse(jsonText);
      if (!Array.isArray(arr)) throw new Error('not array');
      importState.preview = arr.map(function (it) { return { q: String(it.q || ''), a: String(it.a || '(无答案)') }; }).filter(function (it) { return it.q; });
      renderImportModal(); toast('AI 解析完成：' + importState.preview.length + ' 张');
    }).catch(function (e) { toast('AI 解析失败：' + (e.message || '请检查接口和密钥')); });
  }
  function confirmImport() {
    var book = val('imp-book').trim(); var n = 0;
    if (!importState.preview.length) {
      // 兜底：识别不出结构时，把原文整段作为一张笔记卡，保证“下一步”永远能走
      var raw = (importState.text || '').trim();
      if (raw) {
        var fc = newCard(book, '导入的整段笔记', raw);
        state.cards.push(fc); n = 1;
        closeImportModal(); render();
        save(); toast('未识别到结构，已整段导入 1 张（可在书库里手动拆分）');
      } else { toast('没有可导入的内容'); closeImportModal(); render(); return; }
      return;
    }
    // 批量导入：先关闭弹窗并显示加载，避免 94 张大段文本同步保存卡死主线程
    importState.preview.forEach(function (it) {
      if (!it.q) return;
      var c = newCard(book, it.q.trim(), it.a.trim());
      if (it.cloze) { c.cloze = true; c.points = it.points || []; }
      state.cards.push(c); n++;
    });
    closeImportModal();
    showLoading('正在保存 ' + n + ' 张卡片…');
    // 把重活推到下一帧，让加载动画先画出来；直接调用 saveData 不走 300ms 防抖
    setTimeout(function () {
      state.cards.forEach(function (c) { delete c._revealed; });
      saveData(state).then(function () {
        render(); hideLoading(); if (n) toast('已导入 ' + n + ' 张卡片');
      }).catch(function () {
        render(); hideLoading(); toast('导入完成，但云端备份失败');
      });
    }, 40);
  }

  /* ---------- 备份 ---------- */
  function exportData() {
    var blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var name = 'beiji-backup';
    if (MODE === 'server' && session) name += '-' + session.username;
    a.href = url; a.download = name + '-' + todayStr() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出备份');
  }
  function importData(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.cards)) { toast('文件格式不对'); return; }
        if (state.cards.length > 0 && !confirm('导入会覆盖当前 ' + state.cards.length + ' 张卡片，确定继续？')) return;
        d.cards = (d.cards || []).map(normalizeCard);
        state.cards = d.cards;
        state.checkins = Array.isArray(d.checkins) ? d.checkins : [];
        save(); toast('导入成功 ✓');
        exam = null; reviewQueue = null; render();
      } catch (e) { toast('解析失败'); }
    };
    r.readAsText(file);
  }

  /* ---------- 轻提示 ---------- */
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.id = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }
  var toastEl = null;

  /* ---------- 加载中遮罩 ---------- */
  function showLoading(msg) {
    if (!loadingEl) {
      loadingEl = document.createElement('div'); loadingEl.id = 'loading';
      loadingEl.innerHTML = '<div class="spin"></div><div class="msg"></div>';
      document.body.appendChild(loadingEl);
    }
    loadingEl.querySelector('.msg').textContent = msg || '处理中…';
    loadingEl.classList.add('show');
  }
  function hideLoading() { if (loadingEl) loadingEl.classList.remove('show'); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
