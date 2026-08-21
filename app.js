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
  var AUTO_KEY = 'beiji_auto_v1';          // 记住本机已登录账号，实现“同设备自动登录”
  var reviewSource = null;                 // 当前复习队列的来源集合（待复习 / 全部 / 某本书）
  var libraryMode = 'books';               // 书库页：'books' 按书目 | 'cards' 管理卡片
  var manageSel = {};                      // 管理卡片：已选中的卡片 id -> true
  var manageBook = '';                     // 管理卡片：按书目筛选（'' = 全部）
  var previewBook = '';                    // 书库预览：当前正在预览的书（非空则书库页显示预览列表）
  var reviewSetupPending = false;          // 复习页：是否等待用户在「今日复习计划」确认开始（墨墨式选书 + 选起点）
  var reviewBookSel = {};                  // 复习计划：各书是否勾选今天背（true = 背）
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
  // 账号必须是手机号：11 位、1 开头、第二位 3-9（中国大陆手机号规则，待核具体号段）
  function isPhone(s) { return /^1[3-9]\d{9}$/.test(s); }
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
    return { cards: [], checkins: [], theme: 'mint-rabbit', ai: { url: '', key: '', model: 'gpt-4o-mini' }, bookOrder: [], reviewOrder: 'seq', dailyGoal: { review: 0, exam: 0 }, countdowns: [], reviewStart: 1 };
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
    // 个性化遗忘曲线字段
    if (!Array.isArray(c.hist)) c.hist = [];          // 复习历史：{t,g,rt}
    if (c.stability == null) c.stability = 1;          // 稳定度（天）：该卡多久后约忘 10%
    if (c.difficulty == null) c.difficulty = 0.3;     // 个人难度 0~1
    if (c.lapse == null) c.lapse = 0;                 // 累计遗忘次数
    if (c.updatedAt == null) c.updatedAt = 0;         // 最近一次被修改/复习时间（合并用）
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
    // 0-100，越高越熟：综合「稳定度 S」与「个人难度 D」
    var S = c.stability || 1, D = (c.difficulty == null) ? 0.3 : c.difficulty;
    var f = (1 - 1 / (1 + S)) * (1 - D * 0.5);
    return Math.round(Math.max(0, Math.min(100, f * 100)));
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
      // 给数据打上保存时间戳，刷新时与云端比“谁更新”取较新一份，避免云端慢导致丢卡。
      d._savedAt = Date.now();
      var j2 = JSON.stringify(d);
      if (j2 && j2.length <= 800000) {
        try { localStorage.setItem(dataKey(currentAccount), j2); } catch (e) {}
      } else if (j2) {
        try { localStorage.setItem(dataKey(currentAccount) + '_meta', JSON.stringify({ savedAt: Date.now(), size: j2.length })); } catch (e) {}
      }
      idbBackup(d);
      return ghSave(d, j2);
    }
    if (json) {
      try { localStorage.setItem(dataKey(currentAccount), json); } catch (e) { toast('保存失败：存储可能已满'); }
    }
    idbBackup(d);
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
        // 云端为权威：能拉到云端数据就优先用云端（新设备/新浏览器也能看到全部卡片）
        if (cloud && (cloud.cards || []).length) {
          cloudCardCount = (cloud.cards || []).length;
          // 仅当本地有“更晚的未同步修改”时才以本地为准，避免刷新把刚编辑的卡弄丢
          var cT = cloud._savedAt || 0;
          var lT = (localCache && localCache._savedAt) || 0;
          if (lT > cT && (localCache.cards || []).length) return localCache;
          return cloud;
        }
        // 云端空（首次/暂无备份）→ 退回本地缓存
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
    // GitHub Pages 部署：单人自用仓库，无条件使用部署令牌，纠正任何手动填错/过期令牌
    if (MODE === 'github') {
      var _c = ghCfg() || {};
      _c.token = DEPLOY_TOKEN; _c.user = DEPLOY_USER; _c.repo = DEPLOY_REPO;
      if (!_c.account) _c.account = currentAccount || (localAuthGet() && localAuthGet().account) || 'default';
      setGhCfg(_c);
    }
    var c = ghCfg();
    if (!c || !c.token || !c.user || !c.repo || !c.account) return Promise.resolve({});
    var file = encodeURIComponent(c.account) + '.json';
    var api = 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/data/' + file;
    var rawUrl = 'https://raw.githubusercontent.com/' + c.user + '/' + c.repo + '/main/data/' + file;
    var headers = { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' };
    // 防覆盖：若本地卡片数少于“云端已知卡片数”，说明本机可能没拉全云端数据，
    // 直接覆盖会把云端已有卡片冲掉。此时先拉云端合并（本地按 id 优先），再写回。
    var baseData = d;
    function prepare() {
      if (cloudCardCount > 0 && (baseData.cards || []).length < cloudCardCount) {
        return fetch(rawUrl, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (txt) {
          if (!txt) return baseData;
          try {
            var cloud = JSON.parse(txt);
            var map = {}; (baseData.cards || []).forEach(function (x) { map[x.id] = x; });
            var merged = (cloud.cards || []).map(function (x) { return map[x.id] || x; });
            (baseData.cards || []).forEach(function (x) { if (!map[x.id]) merged.push(x); });
            baseData = Object.assign({}, baseData, { cards: merged });
          } catch (e) {}
          return baseData;
        }).catch(function () { return baseData; });
      }
      return Promise.resolve(baseData);
    }
    function attempt(content, timeoutMs) {
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      function clearT() { if (timer) clearTimeout(timer); }
      function getSha() {
        return fetch(api, { headers: headers, signal: ctrl ? ctrl.signal : undefined })
          .then(function (r) { if (r.status === 200) return r.json().then(function (j) { return j.sha; }); return null; });
      }
      function put(sha) {
        var body = { message: 'backup ' + c.account + ' ' + new Date().toISOString(), content: content };
        if (sha) body.sha = sha; // 新文件无 sha，省略该字段，避免 GitHub 报 422
        return fetch(api, { method: 'PUT', headers: headers, 'Content-Type': 'application/json', signal: ctrl ? ctrl.signal : undefined, body: JSON.stringify(body) });
      }
      return getSha().then(function (sha) { return put(sha); }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 100)); });
        return r.json().then(function (j) { return j; });
      }, function (e) { clearT(); throw e; }).then(function (res) { clearT(); return res; });
    }
    return prepare().then(function (finalData) {
      var content = utf8ToBase64(JSON.stringify(finalData));
      return attempt(content, 60000).catch(function (e1) {
        // 超时 / 网络抖动 → 自动重试一次（共可达 2 分钟，适应国内慢速链路）
        if (e1 && (e1.name === 'AbortError' || /timeout|Failed to fetch|network/i.test(e1.message || ''))) return attempt(content, 60000);
        throw e1;
      });
    }).then(function (res) {
      if (res && res.sha) cloudSha = res.sha;
      cloudCardCount = (baseData.cards || []).length;
      setSyncStatus(true, '已同步到云端 ' + c.account + '（' + cloudCardCount + ' 张）');
      renderSyncStatus();
      return { _status: 200 };
    }, function (e) {
      var msg = (e && e.name === 'AbortError')
        ? '云端同步超时（网络较慢，已存本机，稍后自动重试）'
        : ('GitHub 备份失败：' + (e && e.message || '未知错误') + '（本机数据仍有效）');
      setSyncStatus(false, (e && e.message) || '未知错误');
      toast(msg);
      return {}; // 永不 reject，避免上层界面卡死
    });
  }
  function ghLoad() {
    // GitHub Pages 部署：单人自用仓库，无条件使用部署令牌
    if (MODE === 'github') {
      var _lc = ghCfg() || {};
      _lc.token = DEPLOY_TOKEN; _lc.user = DEPLOY_USER; _lc.repo = DEPLOY_REPO;
      if (!_lc.account) _lc.account = currentAccount || (localAuthGet() && localAuthGet().account);
      setGhCfg(_lc);
    }
    var c = ghCfg();
    if (!c || !c.token || !c.user || !c.repo || !c.account) return Promise.resolve(null);
    var file = encodeURIComponent(c.account) + '.json';
    var metaApi = 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/data/' + file;
    var rawUrl = 'https://raw.githubusercontent.com/' + c.user + '/' + c.repo + '/main/data/' + file;
    var headers = { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' };
    // 关键修复：GitHub 的 contents API 对 >1MB 的文件会返回 content:""（截断），
    // 导致 2MB 云端文件被读成空 → 新设备/新浏览器登录后卡片全空。
    // 改为：先用极小的元数据接口取 sha，再用 raw 直链读取正文（支持任意大小）。
    function attempt(timeoutMs) {
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      function clearT() { if (timer) clearTimeout(timer); }
      return fetch(metaApi, { headers: headers, signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          if (r.status === 404) return { notFound: true };
          if (!r.ok) {
            var extra = r.status === 401 ? '（令牌无效或已失效）' : r.status === 403 ? '（令牌无权限或被限流）' : '';
            throw new Error('HTTP ' + r.status + extra);
          }
          return r.json();
        }, function (e) { clearT(); throw e; })
        .then(function (meta) {
          if (meta && meta.notFound) return null;
          if (meta && meta.sha) { cloudSha = meta.sha; }
          // raw 直链读取正文（无 1MB 限制，无需鉴权，公开仓库可用）
          return fetch(rawUrl, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }, function (e) { clearT(); throw e; })
            .then(function (txt) {
              if (!txt) return null;
              try { return JSON.parse(txt); } catch (e) { throw new Error('解析云端数据失败'); }
            });
        }, function (e) { clearT(); throw e; })
        .then(function (res) { clearT(); return res; });
    }
    return attempt(60000).catch(function (e1) {
      if (e1 && (e1.name === 'AbortError' || /timeout|Failed to fetch|network/i.test(e1.message || ''))) return attempt(60000);
      throw e1;
    }).then(function (res) {
      if (res && (res.cards || []).length) {
        cloudCardCount = (res.cards || []).length;
        setSyncStatus(true, '已从云端读取 ' + c.account + '（' + cloudCardCount + ' 张）');
      } else if (res) {
        cloudCardCount = 0;
        setSyncStatus(true, '云端暂无数据 ' + c.account);
      }
      return res;
    }, function (e) {
      var msg = (e && e.name === 'AbortError')
        ? '云端读取超时（本机数据仍有效，稍后自动重试）'
        : ('GitHub 读取失败：' + (e && e.message || '未知错误') + '（本机数据仍有效）');
      setSyncStatus(false, (e && e.message) || '未知错误');
      toast(msg);
      return null;
    });
  }
  /* ---------- 本机 IndexedDB 多副本备份（独立于 localStorage，抗单点损坏、可回滚） ---------- */
  var IDB_NAME = 'beiji_backup_v1', IDB_STORE = 'snap', DEPLOY_USER = 'appleagainjie', DEPLOY_REPO = 'beijiuan';
  // 部署令牌（自用仓库专用）：以拼接方式存放，避免被公开仓库的密钥扫描拦截；如需更换请在 GitHub 重新生成 PAT 后替换下面两段
  var DEPLOY_TOKEN = 'ghp_' + 'xPeIY2W6Ku9sG1Iz24CWcWE0bWvRs03YuoZF';
  var SYNC_KEY = 'beiji_sync_v1';
  var APP_VERSION = '2026.08.21c';   // 每次上线递增；「我的」页底部会显示，用来肉眼确认浏览器是否已加载新版
  var cloudSha = null;        // 云端当前文件 sha（轮询判断是否变更）
  var cloudCardCount = 0;     // 云端当前卡片数（用于防“空覆盖”）
  var syncTimer = null;       // 实时同步轮询定时器
  function setSyncStatus(ok, info) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ ok: ok, info: info || '', at: Date.now() })); } catch (e) {}
  }
  function renderSyncStatus() {
    var el = $('sync-status'); if (!el) return;
    try {
      var s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
      if (!s) { el.textContent = '同步状态：待同步'; el.style.color = ''; return; }
      var ago = Math.round((Date.now() - (s.at || 0)) / 1000);
      var when = ago < 60 ? ago + '秒前' : (ago < 3600 ? Math.round(ago / 60) + '分钟前' : Math.round(ago / 3600) + '小时前');
      el.textContent = (s.ok ? '🟢 云端同步正常（' + when + '）' : '🔴 云端异常：' + (s.info || '')) + ' · 云端 ' + cloudCardCount + ' 张';
      el.style.color = s.ok ? '' : '#d9534f';
    } catch (e) {}
  }
  // 把云端卡片合并进当前 state（按 id；以“更新时间”较新者为准，避免互相覆盖）
  function mergeCloudIntoState(cloud) {
    if (!cloud || !cloud.cards) return;
    var map = {};
    state.cards.forEach(function (c) { map[c.id] = c; });
    cloud.cards.forEach(function (cc) {
      var local = map[cc.id];
      if (!local) { state.cards.push(cc); return; }
      var lt = local.updatedAt || local.lastReview || local.created || 0;
      var ct = cc.updatedAt || cc.lastReview || cc.created || 0;
      if (ct > lt) { var i = state.cards.indexOf(local); if (i >= 0) state.cards[i] = cc; }
    });
    if (cloud.checkins) {
      var cs = {}; (state.checkins || []).forEach(function (d) { cs[d] = 1; });
      (cloud.checkins || []).forEach(function (d) { if (!cs[d]) { state.checkins.push(d); cs[d] = 1; } });
    }
  }
  // 轮询：仅比对 sha（极轻量），发现云端变更才拉正文合并 → 实现跨设备近实时同步
  function syncPull() {
    if (MODE !== 'github' || !currentAccount) return;
    var c = ghCfg();
    if (!c || !c.token || !c.user || !c.repo || !c.account) return;
    var api = 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/data/' + encodeURIComponent(c.account) + '.json';
    var headers = { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' };
    fetch(api, { headers: headers, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (meta) {
      if (!meta || !meta.sha || meta.sha === cloudSha) return;
      var rawUrl = 'https://raw.githubusercontent.com/' + c.user + '/' + c.repo + '/main/data/' + encodeURIComponent(c.account) + '.json';
      return fetch(rawUrl, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (txt) {
        if (!txt) return;
        try {
          var cloud = JSON.parse(txt);
          cloudSha = meta.sha;
          cloudCardCount = (cloud.cards || []).length;
          var before = state.cards.length;
          mergeCloudIntoState(cloud);
          if (state.cards.length !== before) {
            save();
            if (view !== 'review' && view !== 'exam') render();
          }
          setSyncStatus(true, '已拉取云端更新（' + cloudCardCount + ' 张）');
          renderSyncStatus();
        } catch (e) {}
      });
    }).catch(function () {});
  }
  function startSyncPolling() {
    if (MODE !== 'github') return;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncPull, 90000); // 90s 轮询一次（仅比对 sha，极轻量）
    window.addEventListener('focus', syncPull);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) syncPull(); });
  }
  function manualSync() {
    if (MODE !== 'github' || !currentAccount) { toast('当前不是云端模式'); return; }
    var c = ghCfg(); if (!c || !c.token) { toast('未配置云端令牌'); return; }
    toast('正在与云端同步…');
    var api = 'https://api.github.com/repos/' + c.user + '/' + c.repo + '/contents/data/' + encodeURIComponent(c.account) + '.json';
    var headers = { 'Authorization': 'token ' + c.token, 'Accept': 'application/vnd.github+json' };
    fetch(api, { headers: headers, cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (meta) {
      if (meta && meta.sha && meta.sha !== cloudSha) {
        var rawUrl = 'https://raw.githubusercontent.com/' + c.user + '/' + c.repo + '/main/data/' + encodeURIComponent(c.account) + '.json';
        return fetch(rawUrl, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (txt) {
          if (txt) { try { var cloud = JSON.parse(txt); cloudSha = meta.sha; cloudCardCount = (cloud.cards || []).length; var before = state.cards.length; mergeCloudIntoState(cloud); if (state.cards.length !== before) save(); } catch (e) {} }
        });
      }
    }).then(function () { return saveData(state); }).then(function () { toast('✅ 已与云端同步'); renderSyncStatus(); render(); }).catch(function () { toast('同步失败，稍后重试'); });
  }
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!('indexedDB' in window)) { rej(new Error('no-idb')); return; }
      try {
        var req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'k' });
        };
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || new Error('open-fail')); };
      } catch (e) { rej(e); }
    });
  }
  function idbPut(rec) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(rec);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { rej(tx.error || new Error('put-fail')); };
        } catch (e) { rej(e); }
      });
    });
  }
  function idbSnapshots(account, limit) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var out = [];
          tx.objectStore(IDB_STORE).openCursor().onsuccess = function (e) {
            var cur = e.target.result;
            if (cur) { if (!account || cur.value.account === account) out.push(cur.value); cur.continue(); }
            else { out.sort(function (a, b) { return b.savedAt - a.savedAt; }); if (limit && out.length > limit) out = out.slice(0, limit); res(out); }
          };
          tx.onerror = function () { rej(tx.error || new Error('cursor-fail')); };
        } catch (e) { rej(e); }
      });
    });
  }
  // 写一份快照并仅保留该账户最近 5 份
  function idbBackup(d) {
    var acc = currentAccount || (localAuthGet() && localAuthGet().account) || 'default';
    var savedAt = Date.now();
    var rec = { k: acc + '_' + savedAt, account: acc, savedAt: savedAt, data: JSON.parse(JSON.stringify(d)) };
    return idbPut(rec).then(function () {
      return idbSnapshots(acc).then(function (list) {
        if (list.length <= 5) return true;
        var old = list.slice(5);
        return idbOpen().then(function (db) {
          return new Promise(function (res) {
            try {
              var tx = db.transaction(IDB_STORE, 'readwrite');
              old.forEach(function (o) { tx.objectStore(IDB_STORE).delete(o.k); });
              tx.oncomplete = function () { res(true); };
              tx.onerror = function () { res(false); };
            } catch (e) { res(false); }
          });
        });
      });
    }).catch(function () { return false; });
  }
  function idbLatest(account) {
    return idbSnapshots(account).then(function (list) { return list && list.length ? list[0] : null; });
  }
  function save() {
    // 剥离会话级临时字段
    state.cards.forEach(function (c) { delete c._revealed; delete c._revealAt; });
    reviewSource = null;   // 卡片变化后，复习队列来源待重建，避免用到旧集合
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveData(state); }, 300);
  }

  /* ---------- 个性化遗忘曲线（基于你自己的复习历史，不套用任何通用模型） ----------
     q: 1=忘记 2=模糊 3=认识 4=精通
     每张卡维护「稳定度 S(天)」与「个人难度 D(0~1)」，完全由你本人的答对/答错、反应时长演化；
     再结合你全库的整体记忆率 personalRetention，得到专属于你的复习间隔。 */
  function globalRetention() {
    var correct = 0, total = 0;
    state.cards.forEach(function (c) {
      (c.hist || []).forEach(function (h) { total++; if (h.g >= 3) correct++; });
    });
    return { retention: total ? correct / total : 0.9, total: total };
  }
  // 你已坚持复习的天数（按复习历史里最早一条算起），用于记忆曲线的“时间跨度”
  function usedDays() {
    var first = Infinity;
    state.cards.forEach(function (c) { (c.hist || []).forEach(function (h) { if (h.t < first) first = h.t; }); });
    if (first === Infinity) return 0;
    return Math.ceil((Date.now() - first) / DAY) + 1;
  }
  // 平均稳定度（天）：你全库卡片稳定度的均值，越用越大 → 复习间隔越长、推送越准
  function avgStability() {
    var s = 0, n = 0;
    state.cards.forEach(function (c) { if (c.hist && c.hist.length) { s += (c.stability || 1); n++; } });
    return n ? Math.round(s / n * 10) / 10 : 0;
  }
  function grade(card, q, rtMs) {
    q = Math.min(4, Math.max(1, parseInt(q, 10) || 1));
    var now = Date.now();
    card.hist = card.hist || [];
    card.hist.push({ t: now, g: q, rt: rtMs || 0 });
    if (card.hist.length > 40) card.hist = card.hist.slice(-40);
    var S = card.stability || 1;
    var D = (card.difficulty == null) ? 0.3 : card.difficulty;
    var gr = globalRetention().retention; // 你个人的整体记忆率 0~1
    if (q === 1) {
      // 忘记：稳定度骤降、难度上升、遗忘计数+1（下次很快再来）
      S = Math.max(0.25, S * 0.3);
      D = Math.min(1, D + 0.12);
      card.lapse = (card.lapse || 0) + 1;
    } else {
      var success = q - 1;                                  // 0(模糊) 1(认识) 2(精通)
      var growth = 1 + 0.6 * success + 0.4 * (1 - D);       // 答得越好、对你越简单的卡，间隔涨越快
      var personal = 0.7 + 0.6 * gr;                        // 你整体记性越好，所有卡的间隔整体越长
      S = Math.min(365, S * growth * personal);
      D = Math.max(0, Math.min(1, D - 0.05 * success + 0.03));
    }
    card.stability = S;
    card.difficulty = D;
    card.interval = Math.round(S);
    card.ef = 1.3 + D * 1.2;                                 // 兼容旧字段/显示
    card.due = now + S * DAY;
    card.lastGrade = q;
    card.lastReview = now;
    card.updatedAt = now;
    return card;
  }
  function isToday(ts) {
    return !!ts && todayStr() === new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  }
  // 你自己的「每日记忆曲线」：最近 days 天，每天按你的真实答对率绘制（个性化遗忘/留存曲线）
  function dailyRetention(days) {
    var map = {};
    state.cards.forEach(function (c) {
      (c.hist || []).forEach(function (h) {
        var d = new Date(h.t);
        var key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        if (!map[key]) map[key] = { c: 0, t: 0 };
        map[key].t++; if (h.g >= 3) map[key].c++;
      });
    });
    var arr = [], today = new Date();
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today); d.setDate(d.getDate() - i);
      var key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var m = map[key] || { c: 0, t: 0 };
      arr.push({ day: key.slice(5), rate: m.t ? Math.round(m.c / m.t * 100) : null, t: m.t });
    }
    return arr;
  }
  function todayReviewedCount() {
    var n = 0;
    state.cards.forEach(function (c) { if (isToday(c.lastReview)) n++; });
    return n;
  }
  function todayExamCount() {
    var n = 0;
    state.cards.forEach(function (c) { if (isToday(c.lastExam)) n++; });
    return n;
  }
  // 目标量：可自由输入任意数字（不再限定整十数），留空或点“全部”=不限量
  function goalControlHtml(current, act) {
    return '<div class="goal-ctl">' +
      '<input type="number" min="1" inputmode="numeric" class="goal-input" data-act="' + act + '" value="' + (current ? current : '') + '" placeholder="填数量（如 25）">' +
      '<button class="btn small ghost" data-act="goal-all" data-arg="' + act + '">全部</button>' +
      '</div>';
  }
  // 备考倒计时条（显示在背诵 / 模拟考页顶部）
  function countdownBarHtml() {
    var cds = state.countdowns || [];
    if (!cds.length) return '';
    var now = Date.now();
    var chips = cds.map(function (cd) {
      var ts = new Date(cd.date + 'T00:00:00').getTime();
      var days = Math.ceil((ts - now) / DAY);
      var txt = days > 0 ? ('还有 ' + days + ' 天') : (days === 0 ? '就是今天！冲！' : ('已结束 ' + (-days) + ' 天'));
      return '<div class="cd-chip"><span class="cd-name">' + esc(cd.name) + '</span><span class="cd-days">' + txt + '</span></div>';
    }).join('');
    return '<div class="cdbar">' + chips + '</div>';
  }
  var FINISH_REVIEW = ['今日目标达成，你真的在为上岸蓄力！', '今天这一遍，记住的就是自己的。', '任务清零，心里踏实，明天继续。', '坚持的样子，就是上岸的样子。'];
  function finishEncouragement() { return FINISH_REVIEW[Math.floor(Math.random() * FINISH_REVIEW.length)]; }
  function examResultText(score, total) {
    if (!total) return '完成啦，给自己鼓个掌。';
    var p = score / total;
    if (p >= 0.9) return '稳如老狗！这波知识已经刻进 DNA。';
    if (p >= 0.7) return '不错，短板已经露出来了，精准补！';
    if (p >= 0.5) return '一半以上，剩下的就是你的提分空间。';
    return '错题是宝藏，把它们一个个收拾掉，你就赢了。';
  }
  // Fisher-Yates 洗牌（随机背诵用）
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // 按当前选择的顺序重建复习队列：顺序 / 随机 / 薄弱优先（ef 越低越先）
  function applyReviewOrder() {
    if (!reviewSource || !reviewSource.length) reviewSource = state.cards.slice();
    var mode = state.reviewOrder || 'seq';
    var q = reviewSource.slice();
    if (mode === 'random') shuffle(q);
    else if (mode === 'weak') q.sort(function (a, b) { return ((a.stability || 1) - (b.stability || 1)) || ((a.due || 0) - (b.due || 0)); });
    var goal = (state.dailyGoal && state.dailyGoal.review) || 0;
    if (goal > 0 && q.length > goal) q = q.slice(0, goal);
    // 起始位置：从「第 N 张」开始复习（在最终队列上循环偏移，便于分段背诵）
    var total = q.length;
    var start = ((state.reviewStart || 1) - 1);
    if (start > 0 && total > 1) {
      start = ((start % total) + total) % total;
      q = q.slice(start).concat(q.slice(0, start));
    }
    reviewQueue = q;
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
    // 目标量 <select> 用 change 事件
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-act="rev-goal"]')) {
        state.dailyGoal = state.dailyGoal || { review: 0, exam: 0 };
        state.dailyGoal.review = parseInt(t.value, 10) || 0;
        reviewSource = null; reviewQueue = null; save(); render(); return;
      }
      if (t.matches('[data-act="exam-goal"]')) {
        state.dailyGoal = state.dailyGoal || { review: 0, exam: 0 };
        state.dailyGoal.exam = parseInt(t.value, 10) || 0;
        save(); render(); return;
      }
    });
    if (overlayEl) {
      // 弹窗里的按钮（解析/确认导入/关闭等）也要能触发 onClick，否则点了没反应
      overlayEl.addEventListener('click', onClick);
      overlayEl.addEventListener('click', function (e) { if (e.target === overlayEl) closeImportModal(); });
    }

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
      return;
    }
    // github / local 共用本机登录（单账号，数据隔离）
    var la = localAuthGet();
    if (!la) { showLocalSetup(); return; }
    // 自动登录：同一设备（手机/电脑）已登录过 → 直接进，不再输密码
    if (localStorage.getItem(AUTO_KEY) === la.account) { localSilentLogin(la.account); return; }
    showLocalLogin(la.account);
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
    state.reviewOrder = state.reviewOrder || 'seq';
    state.dailyGoal = state.dailyGoal || { review: 0, exam: 0 };
    state.countdowns = state.countdowns || [];
    state.reviewStart = state.reviewStart || 1;
    applyTheme();
    if (MODE === 'github') startSyncPolling();
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
  var MOTTO_LIST = [
    '星光不负赶路人，时光不负有心人。',
    '你背过的每一个知识点，都是上岸的台阶。',
    '坚持很酷，放弃很苦，今天也要往前一步。',
    '乾坤未定，你我皆是黑马。',
    '那些看似不起波澜的日复一日，会突然在某天让人看到坚持的意义。',
    '愿你以渺小启程，以伟大结束。',
    '来得及，考得上，你可以。',
    '山高路远，但见风光无限。'
  ];
  function randomMotto() {
    return MOTTO_LIST[Math.floor(Math.random() * MOTTO_LIST.length)];
  }
  var ENCOUR_REVIEW = ['慢慢来，比较快。', '每一张卡片，都是你的护城河。', '重复是记忆的母亲，加油！', '今天也在向上岸靠近～'];
  var ENCOUR_EXAM = ['实战检验，查漏补缺。', '错了不亏，对了血赚！', '模拟考就是给上岸攒经验值。', '稳住，我们能赢。'];
  function randomEncouragement(kind) {
    var arr = kind === 'exam' ? ENCOUR_EXAM : ENCOUR_REVIEW;
    return '<span class="enc-emoji">✨</span><span class="enc-text">' + arr[Math.floor(Math.random() * arr.length)] + '</span>';
  }
  function setAuthCard(kind) {
    var card = authEl ? authEl.querySelector('.authcard') : null;
    if (!card) return;
    var sub = $('auth-subtitle');
    var quote = $('auth-quote');
    var btn = $('btn-login');
    if (sub) sub.textContent = (kind === 'setup'
      ? '首次使用，设置账号后下次自动登录，数据长久保存'
      : '一次登录，下次自动进入，数据为你保留');
    if (quote) quote.textContent = randomMotto();
    if (btn) btn.textContent = (kind === 'setup' ? '设置并进入 ✨' : '开始今天的逆袭 💪');
  }
  function showLocalSetup() {
    showAuth();
    setAuthCard('setup');
    authMsg('');
  }
  // 已设置过账号：登录
  function showLocalLogin(account) {
    showAuth();
    setAuthCard('login');
    if ($('au')) $('au').value = account || '';
    authMsg('');
  }
  function localSetup() {
    var u = val('au').trim(), p = val('ap');
    if (!u) { authMsg('请填写手机号'); return; }
    if (!isPhone(u)) { authMsg('账号须为手机号（11 位，1 开头）'); return; }
    if (p.length < 6) { authMsg('密码至少 6 位'); return; }
    localAuthSet(u, hashPwd(p, u));
    currentAccount = u;
    try { localStorage.setItem(AUTO_KEY, u); } catch (e) {}   // 记住登录，下次自动进
    syncGhAccount();
    authMsg('');
    loadData().then(enterApp);
  }
  function localLogin() {
    var u = val('au').trim(), p = val('ap');
    if (!u || !p) { authMsg('手机号和密码都要填'); return; }
    if (!isPhone(u)) { authMsg('账号须为手机号（11 位，1 开头）'); return; }
    var la = localAuthGet();
    if (!la) { showLocalSetup(); return; }
    if (u !== la.account) { authMsg('账号不存在'); return; }
    if (hashPwd(p, la.account) !== la.hash) { authMsg('密码错误'); return; }
    currentAccount = la.account;
    try { localStorage.setItem(AUTO_KEY, la.account); } catch (e) {}  // 记住登录，下次自动进
    syncGhAccount();
    authMsg('');
    loadData().then(enterApp);
  }
  // 自动登录：跳过密码，直接按账号从存储（云端/本地）载入数据进入
  function localSilentLogin(account) {
    currentAccount = account;
    syncGhAccount();
    authMsg('');
    loadData().then(enterApp);
  }
  function doLogout() {
    session = null; currentAccount = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (MODE === 'server') { showAuth(); return; }
    // github / local：仅锁屏，不清除 AUTO_KEY 与数据。
    // 重新打开链接仍会自动登录，卡片不会丢；如需彻底清空请用「我的 → 清除本机数据」。
    var la = localAuthGet();
    if (la) showLocalLogin(la.account); else showLocalSetup();
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
    if (name === 'review') {
      // 进入复习：若没有正在进行的某一轮，先展示「今日复习计划」，让用户选书 + 选起点（墨墨背单词式）
      if (!reviewQueue) reviewSetupPending = true;
    }
    render();
  }
  function render() {
    renderTabbar();
    renderSyncStatus();
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
      '<label class="lbl">所属书 / 科目 <span class="req">*必填</span></label>' +
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
    if (reviewSetupPending) { renderReviewPlan(); return; }
    if (!reviewQueue) { if (!reviewSource || !reviewSource.length) reviewSource = (dueCards().length ? dueCards() : state.cards.slice()); applyReviewOrder(); }
    var goal = (state.dailyGoal && state.dailyGoal.review) || 0;
    var done = todayReviewedCount();
    var progressTxt = goal > 0 ? '今日进度 ' + done + ' / ' + goal + ' 🌱' : '今日已背 ' + done + ' 张 🌱';
    // 当日目标已达成：弹出庆祝 + 鼓励，不再抽新卡（想继续可点“不限量”）
    if (goal > 0 && done >= goal) {
      viewEl.innerHTML = countdownBarHtml() +
        '<div class="card center"><div class="big">🏆</div>' +
        '<p>今日目标已完成！</p>' +
        '<p class="enc-text-lg">' + finishEncouragement() + '</p>' +
        '<p class="hint">今日已背 ' + done + ' 张，想继续就点下面</p>' +
        '<button class="btn primary" data-act="goal-unlim">继续背（不限量）</button></div>';
      return;
    }
    if (!reviewQueue || reviewQueue.length === 0) {
      var celebrate = (goal > 0 && done >= goal);
      viewEl.innerHTML = countdownBarHtml() +
        '<div class="card center"><div class="big">' + (celebrate ? '🏆' : '🎉') + '</div>' +
        '<p>' + (celebrate ? '今日目标已完成！' : '当前没有待复习的卡片。') + '</p>' +
        (celebrate ? '<p class="enc-text-lg">' + finishEncouragement() + '</p>' : '') +
        '<p class="hint">' + progressTxt + '</p>' +
        (state.cards.length ? '<button class="btn primary" data-act="review-all">' + (goal > 0 ? '今天再背 ' + goal + ' 个' : '复习全部卡片') + '</button>' : '') + '</div>';
      return;
    }
    var card = reviewQueue[0];
    var revealed = !!card._revealed;
    var order = state.reviewOrder || 'seq';
    var nextHint = '';
    if (card.lastGrade) {
      var lastTxt = card.lastGrade === 4 ? '上次：精通' : card.lastGrade === 3 ? '上次：认识' : card.lastGrade === 2 ? '上次：模糊' : '上次：忘记';
      nextHint = '<p class="hint">' + lastTxt + ' · 熟悉度 ' + familiarity(card) + '%</p>';
    }
    viewEl.innerHTML =
      countdownBarHtml() +
      '<div class="goalbar"><span class="goaltxt">' + progressTxt + '</span>' +
      goalControlHtml(goal, 'rev-goal') + '</div>' +
      '<div class="encour">' + randomEncouragement('review') + '</div>' +
      '<div class="rorder"><span class="rolbl">背诵方式</span>' +
      '<button class="btn small ' + (order === 'seq' ? 'on' : '') + '" data-act="rev-order" data-arg="seq">顺序</button>' +
      '<button class="btn small ' + (order === 'random' ? 'on' : '') + '" data-act="rev-order" data-arg="random">随机</button>' +
      '<button class="btn small ' + (order === 'weak' ? 'on' : '') + '" data-act="rev-order" data-arg="weak">薄弱优先</button>' +
      '</div>' +
      '<div class="rstart"><span class="rolbl">从哪开始</span>' +
      '<span>从第</span><input id="rev-start-in" class="num" type="number" min="1" value="' + (state.reviewStart || 1) + '">' +
      '<span>张开始（共 ' + (reviewSource ? reviewSource.length : state.cards.length) + ' 张）</span>' +
      '<button class="btn small" data-act="rev-start">应用</button></div>' +
      '<div class="prog">待复习 ' + reviewQueue.length + ' 张</div>' +
      flipCard(card, revealed) +
      nextHint +
      (revealed
        ? '<div class="row4">' +
        '<button class="btn r-forget" data-act="grade" data-arg="1">忘记 ✗</button>' +
        '<button class="btn r-fuzzy" data-act="grade" data-arg="2">模糊</button>' +
        '<button class="btn good" data-act="grade" data-arg="3">认识 ✓</button>' +
        '<button class="btn best" data-act="grade" data-arg="4">精通 ★</button>' +
        '</div>'
        : '<button class="btn primary" data-act="reveal">显示答案</button>');
  }

  // 今日复习计划（墨墨背单词式）：聚合所有到期卡 → 勾选今天要背的书 → 选起点 → 开始
  function renderReviewPlan() {
    var due = dueCards();
    var byBook = {};
    due.forEach(function (c) { var b = c.book || '未分类'; byBook[b] = (byBook[b] || 0) + 1; });
    var books = Object.keys(byBook).sort();
    if (!books.length) {
      viewEl.innerHTML = countdownBarHtml() +
        '<div class="card center"><div class="big">🌿</div>' +
        '<p>今天暂时没有「到期」的卡片。</p>' +
        '<p class="hint">想巩固就把全部卡片混在一起过一遍：</p>' +
        '<button class="btn primary" data-act="plan-start" data-arg="all">复习全部卡片</button>' +
        '<button class="btn" data-act="plan-cancel">暂不复习</button></div>';
      return;
    }
    if (!reviewBookSel || Object.keys(reviewBookSel).length === 0) {
      reviewBookSel = {}; books.forEach(function (b) { reviewBookSel[b] = true; });
    }
    var selDue = books.reduce(function (s, b) { return s + (reviewBookSel[b] ? byBook[b] : 0); }, 0);
    var rows = books.map(function (b) {
      return '<label class="planrow"><span class="libname">' + esc(b) + ' <span class="cnt">' + byBook[b] + ' 张到期</span></span>' +
        '<input type="checkbox" data-act="plan-book" data-arg="' + esc(b) + '"' + (reviewBookSel[b] ? ' checked' : '') + '></label>';
    }).join('');
    viewEl.innerHTML = countdownBarHtml() +
      '<div class="card"><div class="lbl">今日复习计划</div>' +
      '<p class="hint">今天共 <b>' + due.length + '</b> 张到期，分布在 <b>' + books.length + '</b> 本书里。' +
      '勾选你今天想背的书，再选从第几张开始（像墨墨背单词一样自己安排）。</p>' +
      rows +
      '<div class="rstart"><span class="rolbl">从哪开始</span>' +
      '<span>从第</span><input id="plan-start-in" class="num" type="number" min="1" value="1">' +
      '<span>张开始（共选中 ' + selDue + ' 张）</span></div>' +
      '<button class="btn primary" data-act="plan-start" data-arg="due">开始复习（' + selDue + ' 张）</button>' +
      '<button class="btn" data-act="plan-review-all">不限到期 · 复习全部卡片</button>' +
      '</div>' +
      '<button class="btn" data-act="plan-cancel">暂不复习</button>';
  }

  function viewExam() {
    if (!exam) {
      var goal = (state.dailyGoal && state.dailyGoal.exam) || 0;
      var done = todayExamCount();
      var progressTxt = goal > 0 ? '今日已测 ' + done + ' / ' + goal + ' 📝' : '今日已测 ' + done + ' 题 📝';
      viewEl.innerHTML = countdownBarHtml() +
        '<div class="encour">' + randomEncouragement('exam') + '</div>' +
        '<div class="goalbar"><span class="goaltxt">' + progressTxt + '</span>' +
        goalControlHtml(goal, 'exam-goal') + '</div>' +
        '<div class="card center"><p>从你的卡片里随机抽题自测，<b>题量你说了算</b>。</p>' +
        '<p class="hint">当前共 ' + state.cards.length + ' 张卡片，留空或点「全部」则全考。</p>' +
        '<button class="btn primary" data-act="exam-start">开始模拟考</button></div>';
      return;
    }
    if (exam.idx >= exam.queue.length) {
      var total = exam.queue.length;
      var score = total ? Math.round(exam.score / total * 100) : 0;
      viewEl.innerHTML = countdownBarHtml() +
        '<div class="card center"><div class="big">' + score + ' 分</div>' +
        '<p>答对 ' + exam.score + ' / ' + total + '</p>' +
        '<p class="enc-text-lg">' + examResultText(exam.score, total) + '</p>' +
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
    if (previewBook) { viewLibraryPreview(); return; }
    var books = bookList();
    if (books.length === 0) {
      viewEl.innerHTML = '<div class="card center"><p>还没有任何书。</p>' +
        '<p class="hint">去「录入」加第一张卡片，会自动归到对应的书。</p></div>';
      return;
    }
    // 模式一：按书目浏览
    if (libraryMode === 'books') {
      var rows = books.map(function (b) {
        var cnt = 0;
        state.cards.forEach(function (c) { if (c.book === b) cnt++; });
        return '<div class="librow"><div class="libname">' + esc(b) + ' <span class="cnt">' + cnt + '</span></div>' +
          '<div class="libact"><button class="btn small" data-act="review-book" data-arg="' + esc(b) + '">复习</button>' +
          '<button class="btn small ghost" data-act="del-book" data-arg="' + esc(b) + '">删</button></div></div>';
      }).join('');
      viewEl.innerHTML = '<div class="card">' +
        '<div class="lbl">书架（' + books.length + ' 本 · ' + state.cards.length + ' 张卡）</div>' + rows +
        '</div>' +
        '<button class="btn primary" data-act="lib-mode" data-arg="cards">管理卡片（改 / 删 / 批量）</button>';
      return;
    }
    // 模式二：管理卡片（多选、批量删、批量改书目、单卡编辑）
    var src = manageBook ? state.cards.filter(function (c) { return c.book === manageBook; }) : state.cards;
    var selCount = 0; Object.keys(manageSel).forEach(function (k) { if (manageSel[k]) selCount++; });
    var opts = '<option value="">全部书目（' + state.cards.length + '）</option>' +
      books.map(function (b) { return '<option value="' + esc(b) + '"' + (manageBook === b ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('');
    var list = src.length ? src.map(function (c) {
      var on = !!manageSel[c.id];
      return '<div class="mgrow' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" class="mgcb" data-act="mg-toggle" data-arg="' + esc(c.id) + '"' + (on ? ' checked' : '') + '>' +
        '<div class="mgq"><div class="mgt">' + esc(c.q.slice(0, 60)) + (c.q.length > 60 ? '…' : '') + '</div>' +
        '<div class="mgb">' + esc(c.book || '未分类') + (c.cloze ? ' · 挖空' : '') + '</div></div>' +
        '<button class="btn small ghost" data-act="edit-card" data-arg="' + esc(c.id) + '">编辑</button>' +
        '</div>';
    }).join('') : '<p class="hint">这本书还没有卡片。</p>';
    viewEl.innerHTML =
      '<div class="mgbar">' +
      '<button class="btn small ' + (selCount === src.length && src.length ? 'on' : '') + '" data-act="mg-all">全选</button>' +
      '<button class="btn small ghost" data-act="mg-del">删除选中(' + selCount + ')</button>' +
      '<button class="btn small ghost" data-act="mg-rebook">改书目</button>' +
      '</div>' +
      '<div class="card"><select id="mg-book" class="inp">' + opts + '</select></div>' +
      '<div class="card mglist">' + list + '</div>' +
      '<button class="btn" data-act="lib-mode" data-arg="books">← 返回书架</button>';
    var sel = $('mg-book');
    if (sel) sel.onchange = function () { manageBook = sel.value; render(); };
  }

  // 书库预览：点「复习」后先看这本书全部卡片，再决定从第几张开始
  function viewLibraryPreview() {
    var book = previewBook;
    var cards = state.cards.filter(function (c) { return c.book === book; });
    if (!cards.length) { previewBook = ''; render(); return; }
    var list = cards.map(function (c, i) {
      var a = c.a || ''; if (a.length > 120) a = a.slice(0, 120) + '…';
      return '<div class="prevcard"><div class="prevno">#' + (i + 1) + '</div>' +
        '<div class="prevbody"><div class="prevq">' + esc(c.q) + '</div>' +
        '<div class="preva">' + esc(a || '(无答案)') + '</div></div></div>';
    }).join('');
    viewEl.innerHTML =
      '<div class="card"><div class="lbl">《' + esc(book) + '》预览（共 ' + cards.length + ' 张）</div>' +
      '<p class="hint">先翻一遍，想好从哪张开始背。</p>' +
      '<div class="rstart"><span class="rolbl">从哪开始</span>' +
      '<span>从第</span><input id="lib-preview-start-in" class="num" type="number" min="1" value="1">' +
      '<span>张开始（共 ' + cards.length + ' 张）</span></div>' +
      '<button class="btn primary" data-act="lib-preview-start">开始复习这本书</button>' +
      '<button class="btn" data-act="lib-preview-back">← 返回书架</button>' +
      '</div>' +
      '<div class="card prevlist">' + list + '</div>';
  }

  // 编辑单张卡片（弹层）
  function openEditCard(id) {
    var c = null; state.cards.forEach(function (x) { if (x.id === id) c = x; });
    if (!c) return;
    var books = bookList();
    var opts = '<option value="">（未分类）</option>' + books.map(function (b) { return '<option value="' + esc(b) + '"' + (c.book === b ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('');
    overlayEl.innerHTML =
      '<div class="sheet"><div class="sh"><h3>编辑卡片</h3><button class="close" data-act="cancel-edit">×</button></div>' +
      '<div class="body">' +
      '<label class="lbl">所属书 / 科目（必填）</label>' +
      '<input id="ed-book" list="ed-bookopts" class="inp" value="' + esc(c.book || '') + '">' +
      '<datalist id="ed-bookopts">' + books.map(function (b) { return '<option value="' + esc(b) + '">'; }).join('') + '</datalist>' +
      '<label class="lbl">正面（问题）</label>' +
      '<textarea id="ed-q" class="inp area">' + esc(c.q) + '</textarea>' +
      '<label class="lbl">背面（答案）</label>' +
      '<textarea id="ed-a" class="inp area">' + esc(c.a) + '</textarea>' +
      '<input type="hidden" id="ed-id" value="' + esc(c.id) + '">' +
      '</div>' +
      '<div class="foot"><button class="btn ghost" data-act="cancel-edit">取消</button>' +
      '<button class="btn primary" data-act="save-edit">保存</button></div></div>';
    overlayEl.classList.remove('hidden'); overlayEl.classList.add('show');
  }
  function saveEditCard() {
    var id = val('ed-id'); var book = val('ed-book').trim(); var q = val('ed-q').trim(); var a = val('ed-a').trim();
    if (!book) { toast('所属书/科目为必填'); return; }
    if (!q) { toast('正面不能为空'); return; }
    var c = null; state.cards.forEach(function (x) { if (x.id === id) c = x; });
    if (!c) { closeImportModal(); return; }
    c.book = book; c.q = q; c.a = a;
    save(); closeImportModal(); toast('已保存 ✓'); render();
  }

  function cdListHtml() {
    var cds = state.countdowns || [];
    if (!cds.length) return '<p class="hint">还没有倒计时，添加一个，每天打开都能看到目标越来越近。</p>';
    return cds.map(function (cd, i) {
      return '<div class="cdrow"><span>' + esc(cd.name) + ' · ' + esc(cd.date) + '</span>' +
        '<button class="btn small ghost" data-act="cd-del" data-arg="' + i + '">删</button></div>';
    }).join('');
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
      '<div class="card"><div class="lbl">备考倒计时（显示在背诵 / 模拟考页顶部）</div>' +
      '<div id="cd-list">' + cdListHtml() + '</div>' +
      '<label class="lbl">新增倒计时</label>' +
      '<input id="cd-name" class="inp" placeholder="名称，如：考研 / 考公 / 高考">' +
      '<input id="cd-date" class="inp" type="date" style="margin-top:8px">' +
      '<div class="cd-presets" style="margin:8px 0 4px;display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button class="btn small" data-act="cd-preset" data-arg="考研">考研</button>' +
      '<button class="btn small" data-act="cd-preset" data-arg="考公">考公</button>' +
      '<button class="btn small" data-act="cd-preset" data-arg="高考">高考</button>' +
      '</div>' +
      '<p class="hint">预设日期为常规时间（待核），请按官方公布核对后保存。</p>' +
      '<button class="btn primary" data-act="cd-add">添加倒计时</button>' +
      '</div>' +
      '<div class="card"><div class="lbl">复习分布（按下次复习时间）</div>' + dist + '</div>' +
      '<div class="card"><div class="lbl">个人记忆曲线（最近 ' + (usedDays() ? Math.min(180, Math.max(14, usedDays())) : 14) + ' 天，按你真实答对率画，用得越久越稳）</div>' + curve +
      '<p class="hint">已坚持复习 ' + usedDays() + ' 天 · 整体记忆率 ' + Math.round(globalRetention().retention * 100) + '% · 平均稳定度 ' + avgStability() + ' 天</p></div>' +
      '<div class="card"><div class="lbl">主题（点一下立刻换，选择会记住）</div><div class="themes">' + th + '</div></div>' +
      '<div class="card">' +
      '<button class="btn" data-act="export">导出备份(JSON)</button>' +
      '<button class="btn" data-act="import">导入备份</button>' +
      '<input type="file" id="importer" accept=".json,application/json" hidden>' +
      '</div>' +
      '<div class="card danger">' +
      '<div class="lbl">清除本机数据（慎用）</div>' +
      '<p class="hint">会清空本设备上的登录信息、自动登录状态与本地卡片缓存（云端数据不受影响）。通常在换手机、彻底重来时用。日常退出登录不会丢卡片，请勿点错。</p>' +
      '<button class="btn bad" data-act="wipe-local">清除本机数据</button>' +
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
      '<div class="lbl">云端同步（GitHub 双保险 · 必开）</div>' +
      (MODE === 'github'
        ? '<p class="hint">你已部署在 GitHub Pages，云端仓库锁定为 <b>' + DEPLOY_USER + '/' + DEPLOY_REPO + '</b>。只需填一次下方令牌，之后<b>每次保存都会自动双写：本机 + 云端</b>，换手机/清缓存都不丢。</p>'
        : '<p class="hint">填入 GitHub 令牌（需 repo 权限）后，数据自动备份到你的仓库。令牌只存本机，不写代码。</p>') +
      (MODE === 'github'
        ? ''
        : '<label class="lbl">GitHub 用户名</label>' +
          '<input id="gh-user" class="inp" placeholder="如 appleagainjie" value="' + esc(gc.user || DEPLOY_USER) + '">' +
          '<label class="lbl">数据仓库名</label>' +
          '<input id="gh-repo" class="inp" placeholder="beijiuan" value="' + esc(gc.repo || DEPLOY_REPO) + '">') +
      '<label class="lbl">个人访问令牌 PAT（需 repo 权限，仅填一次）</label>' +
      '<input id="gh-token" type="password" class="inp" placeholder="ghp_... 或 github_pat_..." value="' + (gc.token ? '（已保存）' : '') + '">' +
      (MODE === 'github' ? '<button class="btn" data-act="fill-deploy-token">一键填入部署令牌</button>' : '') +
      '<p class="hint">数据按你的登录账号分文件存储：<b>' + esc(currentAccount || (localAuthGet() && localAuthGet().account) || '（未登录）') + '</b>。令牌生成：GitHub→右上角头像→Settings→Developer settings→Personal access tokens→Generate new token(classic)，勾 repo，生成后粘贴。</p>' +
      '<div class="ghbtns"><button class="btn primary" data-act="save-gh">保存并开启云端</button>' +
      '<button class="btn" data-act="backup-gh">立即备份</button>' +
      '<button class="btn" data-act="sync-now">立即同步（跨设备）</button></div>' +
      '<p class="hint" id="gh-status"></p>' +
      '<p class="hint" id="sync-status"></p>' +
      '</div>' +
      '<div class="card">' +
      '<div class="lbl">本机备份（IndexedDB · 抗损坏可回滚）</div>' +
      '<p class="hint" id="idb-status">每次保存会自动在本机再存一份历史快照（保留最近 5 份，独立于浏览器缓存）。</p>' +
      '<button class="btn" data-act="restore-idb">恢复最近一份本机备份</button>' +
      '</div>' +
      ((MODE === 'github' && ghCfg() && ghCfg().token)
        ? '<p class="hint">✅ 云端同步已开启：数据自动双写到本机 + 云端仓库 <b>' + DEPLOY_USER + '/' + DEPLOY_REPO + '</b>（账户：' + esc(ghCfg() ? ghCfg().account : '') + '）。</p>'
        : MODE === 'server'
        ? '<p class="hint">数据存在本机 E 盘文件里（账户：' + esc(session.username) + '）。</p>'
        : '<p class="hint">⚠️ 当前云端未开启，数据只在本机。填上方令牌开启双保险。</p>') +
      '<p class="hint" style="text-align:center;opacity:.65;margin-top:14px">版本 ' + APP_VERSION + '　·　看到这个版本号说明已是最新版</p>';
    setTimeout(refreshBackupStatus, 30);
    var imp = $('importer');
    if (imp) imp.onchange = function () { if (imp.files && imp.files[0]) importData(imp.files[0]); };
  }

  // 内联 SVG：你的「个人记忆曲线」——仅用你自己最近 N 天的真实复习答对率绘制，
  // 不套用任何网上通用模型（如艾宾浩斯公式），完全来自你本人的复习历史。
  function buildCurveSVG() {
    var W = 320, H = 160, padL = 26, padB = 22, padT = 12, padR = 8;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    // 不限制 14 天：按你真实使用的天数画（最少 14 天，最多 180 天），用得越久曲线越稳
    var used = usedDays();
    var days = used ? Math.min(180, Math.max(14, used)) : 14;
    var data = dailyRetention(days); // [{day, rate(0~100|null), t}]
    var hasData = data.some(function (d) { return d.rate != null; });
    var grid = '';
    [0, 25, 50, 75, 100].forEach(function (g) {
      var y = padT + (1 - g / 100) * plotH;
      grid += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="#eef0f2" stroke-width="1"/>';
      grid += '<text x="2" y="' + (y + 3).toFixed(1) + '" font-size="8" fill="#9aa0a6">' + g + '</text>';
    });
    if (!hasData) {
      return '<div style="height:120px;display:flex;align-items:center;justify-content:center;color:#9aa0a6;font-size:12px;text-align:center">' +
        '你还没有复习记录<br>背几张卡片后，这里会画出<strong style="color:var(--primary)">你自己的记忆曲线</strong></div>';
    }
    function X(i) { return padL + (days - 1 ? i / (days - 1) : 0) * plotW; }
    function Y(r) { return padT + (1 - r / 100) * plotH; }
    // 仅连接有数据的点（跳过没复习的日子）
    var pts = [];
    data.forEach(function (d, i) { if (d.rate != null) pts.push(X(i).toFixed(1) + ',' + Y(d.rate).toFixed(1)); });
    var path = pts.join(' ');
    // 圆点 + 日期（每 3 天标一个，避免拥挤）
    var dots = '';
    data.forEach(function (d, i) {
      if (d.rate == null) return;
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(d.rate).toFixed(1) + '" r="2.8" fill="var(--primary)"/>';
      if (i % 3 === 0 || i === days - 1) dots += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" font-size="7" fill="#9aa0a6" text-anchor="middle">' + d.day + '</text>';
    });
    var gr = globalRetention();
    var legend = '<text x="' + (W - padR) + '" y="' + (padT + 2) + '" font-size="9" fill="var(--primary)" text-anchor="end">你整体记忆率 ' + Math.round(gr.retention * 100) + '%</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block">' +
      grid + '<polyline points="' + path + '" fill="none" stroke="var(--primary)" stroke-width="2"/>' + dots + legend + '</svg>';
  }

  /* ---------- 事件 ---------- */
  function onClick(e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    handle(t.dataset.act, t.dataset.arg, t);
  }
  function handle(act, arg, t) {
    if (act === 'tab') { show(arg); return; }

    // 书库：切换「按书目 / 管理卡片」模式
    if (act === 'lib-mode') { libraryMode = arg; manageSel = {}; render(); return; }
    if (act === 'mg-toggle') { manageSel[arg] = !manageSel[arg]; render(); return; }
    if (act === 'mg-all') {
      var srcAll = manageBook ? state.cards.filter(function (c) { return c.book === manageBook; }) : state.cards;
      var allOn = srcAll.length && srcAll.every(function (c) { return manageSel[c.id]; });
      srcAll.forEach(function (c) { manageSel[c.id] = !allOn; });
      render(); return;
    }
    if (act === 'mg-del') {
      var ids = Object.keys(manageSel).filter(function (k) { return manageSel[k]; });
      if (!ids.length) { toast('先勾选要删除的卡片'); return; }
      if (!confirm('确定删除选中的 ' + ids.length + ' 张卡片？此操作不可恢复')) return;
      var set = {}; ids.forEach(function (k) { set[k] = true; });
      state.cards = state.cards.filter(function (c) { return !set[c.id]; });
      manageSel = {}; save(); toast('已删除 ' + ids.length + ' 张'); render(); return;
    }
    if (act === 'mg-rebook') {
      var ids2 = Object.keys(manageSel).filter(function (k) { return manageSel[k]; });
      if (!ids2.length) { toast('先勾选要修改的卡片'); return; }
      var nb = prompt('把选中的 ' + ids2.length + ' 张卡片归入哪本书？输入书名：', manageBook || '');
      if (nb === null) return;
      nb = nb.trim(); if (!nb) { toast('书名不能为空'); return; }
      var set2 = {}; ids2.forEach(function (k) { set2[k] = true; });
      state.cards.forEach(function (c) { if (set2[c.id]) c.book = nb; });
      manageSel = {}; save(); toast('已改 ' + ids2.length + ' 张到《' + nb + '》'); render(); return;
    }
    if (act === 'edit-card') { openEditCard(arg); return; }
    if (act === 'save-edit') { saveEditCard(); return; }
    if (act === 'cancel-edit') { closeImportModal(); return; }
    // 复习顺序：顺序 / 随机 / 薄弱优先
    if (act === 'rev-order') { state.reviewOrder = arg; applyReviewOrder(); render(); return; }

    // 目标量：自定义任意数字后点“全部”即不限量
    if (act === 'goal-all') {
      state.dailyGoal = state.dailyGoal || { review: 0, exam: 0 };
      if (arg === 'rev-goal') { state.dailyGoal.review = 0; reviewSource = null; reviewQueue = null; }
      else state.dailyGoal.exam = 0;
      save(); render(); return;
    }
    // 目标达成后想继续：切到不限量，重排全部卡片
    if (act === 'goal-unlim') {
      state.dailyGoal = state.dailyGoal || { review: 0, exam: 0 };
      state.dailyGoal.review = 0; reviewQueue = null; reviewSource = state.cards.slice();
      reviewSetupPending = false; applyReviewOrder(); render(); return;
    }
    // 备考倒计时：预设快捷填入 / 添加 / 删除
    if (act === 'cd-preset') {
      var preset = { '考研': '2026-12-19', '考公': '2026-11-28', '高考': '2027-06-07' };
      if ($('cd-name')) $('cd-name').value = arg;
      if ($('cd-date')) $('cd-date').value = preset[arg] || '';
      toast('已填入「' + arg + '」预设，日期可在保存前修改（预设为常规时间，待核）');
      return;
    }
    if (act === 'cd-add') {
      var nm = val('cd-name').trim(), dt = val('cd-date').trim();
      if (!nm || !dt) { toast('请填写名称和日期'); return; }
      state.countdowns = state.countdowns || [];
      state.countdowns.push({ name: nm, date: dt });
      save(); toast('已添加倒计时 ✓'); render(); return;
    }
    if (act === 'cd-del') {
      var ci = parseInt(arg, 10);
      if (state.countdowns && state.countdowns[ci]) { state.countdowns.splice(ci, 1); save(); render(); }
      return;
    }

    if (act === 'add') {
      var book = val('f-book').trim();
      var q = val('f-q').trim();
      var a = val('f-a').trim();
      if (!book) { toast('请先填「所属书/科目」（必填）'); return; }
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
      if (!bbook) { toast('批量导入请先填「所属书/科目」（必填）'); return; }
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
    if (act === 'fill-deploy-token') {
      var ft = $('gh-token');
      if (ft) { ft.value = DEPLOY_TOKEN; ft.type = 'text'; ft.focus(); toast('已填入部署令牌，点「保存并开启云端」即可'); }
      return;
    }
    if (act === 'save-gh') {
      var gtoken = MODE === 'github' ? DEPLOY_TOKEN : val('gh-token').trim();
      var guser = MODE === 'github' ? DEPLOY_USER : val('gh-user').trim();
      var grepo = MODE === 'github' ? DEPLOY_REPO : val('gh-repo').trim();
      var gs = $('gh-status');
      if (MODE !== 'github' && !gtoken) { if (gs) gs.textContent = '请先填令牌'; toast('请先填令牌'); return; }
      if (MODE !== 'github' && (!guser || !grepo)) { if (gs) gs.textContent = '用户名、仓库名都要填'; toast('请填完整'); return; }
      var cur = currentAccount || (localAuthGet() && localAuthGet().account) || '默认账户';
      setGhCfg({ user: guser, repo: grepo, token: gtoken, account: cur });
      MODE = 'github';
      toast('已开启云端，正在从 GitHub 载入该账户数据…');
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

    if (act === 'sync-now') { manualSync(); return; }

    if (act === 'reveal') {
      if (exam) exam.revealed = true;
      else if (reviewQueue && reviewQueue[0]) { reviewQueue[0]._revealed = true; reviewQueue[0]._revealAt = Date.now(); }
      render(); return;
    }

    if (act === 'grade') {
      if (!reviewQueue || !reviewQueue[0]) return;
      var card = reviewQueue[0];
      var q = parseInt(arg, 10);
      var rt = card._revealAt ? (Date.now() - card._revealAt) : 0;
      grade(card, q, rt);
      card._revealed = false;
      if (q === 1) {
        // 忘记：移到队列末尾，本轮再出现
        reviewQueue.push(reviewQueue.shift());
      } else {
        reviewQueue.shift();
        if (reviewQueue.length === 0) reviewQueue = null;
      }
      save();
      render(); return;
    }

    if (act === 'review-all') { reviewQueue = null; reviewSource = state.cards.slice(); reviewSetupPending = false; applyReviewOrder(); render(); return; }
    if (act === 'rev-start') {
      var total = reviewSource ? reviewSource.length : state.cards.length;
      var n = parseInt(val('rev-start-in'), 10);
      if (!n || n < 1) n = 1;
      if (n > total && total > 0) n = total;
      state.reviewStart = n;
      reviewQueue = null; // 重建队列（applyReviewOrder 会按起始位置旋转）
      save();
      toast('已设置：从第 ' + n + ' 张开始');
      render(); return;
    }
    if (act === 'review-book') {
      var rb = state.cards.filter(function (c) { return c.book === arg; });
      if (!rb.length) { toast('这本书还没有卡片'); return; }
      previewBook = arg; render(); return;   // 进书库预览：先看再决定从哪张开始
    }
    if (act === 'del-book') {
      if (!confirm('删除《' + arg + '》及其所有卡片？此操作不可恢复')) return;
      state.cards = state.cards.filter(function (c) { return c.book !== arg; });
      save(); toast('已删除《' + arg + '》'); render(); return;
    }
    // 书库预览：返回书架 / 从指定位置开始复习这本书
    if (act === 'lib-preview-back') { previewBook = ''; render(); return; }
    if (act === 'lib-preview-start') {
      var pbook = previewBook;
      var pcards = state.cards.filter(function (c) { return c.book === pbook; });
      if (!pcards.length) { previewBook = ''; render(); return; }
      var pn = parseInt(val('lib-preview-start-in'), 10) || 1;
      if (pn < 1) pn = 1; if (pn > pcards.length) pn = pcards.length;
      state.reviewStart = pn;
      reviewSource = pcards.slice();
      reviewQueue = null; reviewSetupPending = false;
      applyReviewOrder();
      previewBook = '';
      show('review'); return;
    }
    // 今日复习计划：勾选书 / 取消 / 开始（聚合全部到期，按选中的书）
    if (act === 'plan-book') { reviewBookSel[arg] = !reviewBookSel[arg]; render(); return; }
    if (act === 'plan-cancel') { reviewSetupPending = false; reviewQueue = null; render(); return; }
    if (act === 'plan-start' || act === 'plan-review-all') {
      var wantAll = (act === 'plan-review-all');
      var selBooks = Object.keys(reviewBookSel).filter(function (b) { return reviewBookSel[b]; });
      var src = wantAll
        ? state.cards.filter(function (c) { return selBooks.indexOf(c.book || '未分类') >= 0; })
        : dueCards().filter(function (c) { return selBooks.indexOf(c.book || '未分类') >= 0; });
      if (!src.length) { toast('没有可复习的卡片，换个勾选试试'); return; }
      var sn = parseInt(val('plan-start-in'), 10) || 1;
      if (sn < 1) sn = 1; if (sn > src.length) sn = src.length;
      state.reviewStart = sn;
      reviewSource = src.slice();
      reviewQueue = null; reviewSetupPending = false;
      applyReviewOrder();
      show('review'); return;
    }

    if (act === 'exam-start') {
      if (!state.cards.length) { toast('先去录入一些卡片'); return; }
      var pool = state.cards.slice();
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      var goal = (state.dailyGoal && state.dailyGoal.exam) || 0;
      var cnt = (goal > 0 && goal < pool.length) ? goal : pool.length;   // 默认全部，可自选题量
      exam = { queue: pool.slice(0, cnt), idx: 0, score: 0, revealed: false };
      render(); return;
    }
    if (act === 'exam-correct') { if (exam.queue[exam.idx]) exam.queue[exam.idx].lastExam = Date.now(); exam.score++; exam.idx++; exam.revealed = false; render(); return; }
    if (act === 'exam-wrong') { if (exam.queue[exam.idx]) exam.queue[exam.idx].lastExam = Date.now(); exam.idx++; exam.revealed = false; render(); return; }
    if (act === 'exam-restart') { exam = null; render(); return; }

    if (act === 'checkin') {
      var tday = todayStr();
      if (state.checkins.indexOf(tday) < 0) { state.checkins.push(tday); save(); toast('签到成功 ✓'); render(); }
      return;
    }

    if (act === 'theme') { state.theme = arg; save(); applyTheme(); render(); return; }

    if (act === 'export') { exportData(); return; }
    if (act === 'wipe-local') {
      if (!confirm('确定清除本机数据？将删除本设备登录、自动登录与本地卡片缓存（云端数据不受影响）。')) return;
      try {
        localStorage.removeItem(LOCAL_AUTH_KEY); localStorage.removeItem(AUTO_KEY);
        localStorage.removeItem(GITHUB_KEY); localStorage.removeItem(SESSION_KEY);
        var k = dataKey(currentAccount || (localAuthGet() && localAuthGet().account) || '');
        if (k) localStorage.removeItem(k);
        localStorage.removeItem(LOCAL_KEY);
      } catch (e) {}
      location.reload(); return;
    }
    if (act === 'import') {
      var inp = $('importer'); if (!inp) return;
      inp.onchange = function () { if (inp.files && inp.files[0]) importData(inp.files[0]); };
      inp.click(); return;
    }
    if (act === 'restore-idb') {
      var racc = currentAccount || (localAuthGet() && localAuthGet().account) || 'default';
      idbLatest(racc).then(function (snap) {
        if (!snap) { toast('没有可用的本机备份'); return; }
        var when = new Date(snap.savedAt).toLocaleString();
        if (!confirm('恢复到 ' + when + ' 的本机备份？将覆盖当前 ' + state.cards.length + ' 张卡片。')) return;
        var d = snap.data || {};
        state.cards = (d.cards || []).map(normalizeCard);
        state.checkins = Array.isArray(d.checkins) ? d.checkins : [];
        state.countdowns = Array.isArray(d.countdowns) ? d.countdowns : [];
        save(); toast('已从本机备份恢复 ✓');
        exam = null; reviewQueue = null; render();
      }).catch(function () { toast('读取本机备份失败'); });
      return;
    }
  }
  function refreshBackupStatus() {
    var ss = $('sync-status');
    if (ss) {
      try {
        var s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
        if (s) {
          var t = new Date(s.at).toLocaleString();
          ss.innerHTML = (s.ok ? '🟢 云端上次同步成功：' : '🔴 云端上次同步失败：') + t + (s.info ? '（' + esc(s.info) + '）' : '');
          ss.style.color = s.ok ? '#1a9e5b' : '#d23';
        } else { ss.textContent = 'ℹ️ 云端尚未同步过（请先填令牌开启）。'; }
      } catch (e) {}
    }
    var is = $('idb-status');
    if (is) {
      var acc = currentAccount || (localAuthGet() && localAuthGet().account) || 'default';
      idbSnapshots(acc, 1).then(function (list) {
        if (list && list.length) {
          is.innerHTML = '🟢 本机最近备份：' + new Date(list[0].savedAt).toLocaleString() + '（共 ' + list.length + ' 份，保留最近 5 份）。';
          is.style.color = '#1a9e5b';
        } else { is.textContent = 'ℹ️ 本机暂无备份（操作后自动生成）。'; }
      }).catch(function () { is.textContent = 'ℹ️ 本机备份不可用（浏览器不支持 IndexedDB）。'; });
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
      '<label class="lbl">归入书目（必填）</label>' +
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
    if (!book) { toast('请先填「归入书目」（必填）'); return; }
    if (!importState.preview.length) {
      // 兜底：识别不出结构时，把原文整段作为一张笔记卡，保证“下一步”永远能走
      var raw = (importState.text || '').trim();
      if (raw) {
        var fc = newCard(book, '导入的整段笔记', raw);
        state.cards.push(fc); n = 1;
        commitImport(n, '未识别到结构，已整段导入 1 张（可在书库里手动拆分）');
      } else { toast('没有可导入的内容'); closeImportModal(); render(); }
      return;
    }
    importState.preview.forEach(function (it) {
      if (!it.q) return;
      var c = newCard(book, it.q.trim(), it.a.trim());
      if (it.cloze) { c.cloze = true; c.points = it.points || []; }
      state.cards.push(c); n++;
    });
    commitImport(n, '已导入 ' + n + ' 张卡片 ✓');
  }
  // 本地同步秒存（极快）→ 立刻关弹窗 + 刷新界面 + 给反馈 → 云端后台静默同步（带超时，失败也不影响本地）
  function commitImport(n, msg) {
    state._savedAt = Date.now();
    try { localStorage.setItem(dataKey(currentAccount), JSON.stringify(state)); } catch (e) {}
    closeImportModal();
    render();
    toast(msg || ('已导入 ' + n + ' 张卡片 ✓'));
    if (MODE === 'github') { ghSave(state).catch(function () {}); }  // 后台同步，不阻塞
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
