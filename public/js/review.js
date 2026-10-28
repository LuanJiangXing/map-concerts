/* review.js —— 审核页(admin)。顶层模块:演出提交 / 用户 / 标签管理 / 歌手 / 统计 / 访问分析 / 审计。
 * 四状态列表(待审核/已驳回/已通过/回收站)+ 歌手筛选收进「演出提交」栏目(状态分段)。
 * 通过/驳回由后端处理(草稿合并、自动标签派生在 src/review.js)。
 * 标签管理 = 目录 CRUD + pending 提案批量审批(checkbox 独立 class,与提交批量隔离)。 */

(function () {
  'use strict';

  // 大头照缓存版本:站内头像路径由 _headers 以 immutable 1 天缓存,内容替换后同 URL
  // 大头照缓存版本:统一走 Auth.avatarSrc
  var avatarSrc = Auth.avatarSrc;

  var current = 'submissions'; // 顶层模块:submissions | users | tags | singers | stats | analytics | audit
  var statusSel = 'pending';   // 「演出提交」栏目下当前状态列表:pending/rejected/approved/trash
  var statusSinger = '';       // 「演出提交」栏目歌手筛选('' = 全部)
  var tagCache = {}; // 目录缓存:key = 歌手 slug(''=全库);v6 歌曲身份=(歌手,歌名),故按歌手分桶
  var songFilterSinger = ''; // 标签管理「歌曲」区块当前筛选歌手(reload/改名后保留选择)
  var songSearchKeyword = ''; // 标签管理「歌曲」区块当前搜索词
  var me = null; // 当前登录 admin(/api/auth/me,含 super_admin 标记)
  var singerApproveOverlay = null;   // 批准确认层(预览 URL + 可编辑 slug)
  var approveExistingIds = {};       // 已入驻 singer id → 冲突提示(打开确认层时拉取)
  /** 待审核批量选择:batchSel = {id:true}。checkbox 用 .review-item__checkbox,
   *  与标签提案的 .review-item__tag-checkbox 隔离,互不串选。 */
  var batchSel = {};

  function selectedBatchIds() {
    return Object.keys(batchSel).filter(function (k) { return batchSel[k]; });
  }
  function updateBatchBar() {
    var bar = document.getElementById('review-batch-bar');
    if (!bar) return;
    var ids = selectedBatchIds();
    bar.hidden = !ids.length;
    var c = document.getElementById('review-batch-count');
    if (c) c.textContent = ids.length + ' 条已选';
  }
  function syncSelAll() {
    var sa = document.getElementById('review-selall-cb');
    if (!sa) return;
    var cbs = Array.prototype.slice.call(document.querySelectorAll('#review-list .review-item__checkbox'));
    var total = cbs.length, checked = 0;
    cbs.forEach(function (c) { if (c.checked) checked++; });
    sa.checked = total > 0 && checked === total;
    sa.indeterminate = total > 0 && checked > 0 && checked < total;
  }
  function setSelAllVisible(show) {
    var l = document.getElementById('review-selall');
    if (l) l.hidden = !show;
  }
  /** 清空批量选择:隐藏批量条 / 全选,取消已勾选(切模块或列表重载时调用) */
  function resetBatchUI() {
    batchSel = {};
    var bar = document.getElementById('review-batch-bar');
    if (bar) bar.hidden = true;
    var sa = document.getElementById('review-selall-cb');
    if (sa) { sa.checked = false; sa.indeterminate = false; }
    setSelAllVisible(false);
  }

  /** 醒目的错误状态展示 (如服务器错误 / 网络异常) */
  function renderError(box, msg, retryFn) {
    if (!box) return;
    var errText = (typeof msg === 'string' && msg) ? msg : '服务器错误或网络异常，请稍后重试';
    var icon = (window.ICONS && window.ICONS.svg)
      ? ICONS.svg('alert', 40)
      : '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    var html =
      '<div class="state-error" role="alert">' +
        '<div class="state-error__icon">' + icon + '</div>' +
        '<div class="state-error__title">数据加载异常</div>' +
        '<div class="state-error__msg">' + Auth.esc(errText) + '</div>' +
        (retryFn ? '<button type="button" class="btn state-error__retry">重新加载</button>' : '') +
      '</div>';
    box.innerHTML = html;
    if (retryFn) {
      var btn = box.querySelector('.state-error__retry');
      if (btn) btn.addEventListener('click', retryFn);
    }
  }
  /** 输密码期间就开始拉数据(geoguide 模式):页面解析即预拉默认 tab + 标签目录;
   *  失败(未解锁)自动清除,解锁后 load() 里兜底重拉。key 用完整 status 便于按 tab 复用 */
  var _preload = {};

  function preloadNow() {
    // 非 2xx(未解锁 401/403)视为失败并清 key,解锁后 load() 会兜底重拉
    _preload['review:pending'] = fetch('/api/review?status=pending')
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .catch(function () { delete _preload['review:pending']; });
    _preload['tags'] = fetch('/api/tags')
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .catch(function () { delete _preload['tags']; });
  }

  /** 目录(含歌手作用域):singer 给定时后端只把「歌曲」类别收窄为该歌手,非歌曲类别全量。
   *  缓存按歌手分桶;'' 走预加载(输密码期间已拉全量目录)。 */
  function loadCatalog(singer) {
    var key = singer || '';
    if (tagCache[key] && tagCache[key].categories.length) return Promise.resolve(tagCache[key]);
    if (!key) {
      var cached = _preload['tags'];
      if (cached) {
        delete _preload['tags'];
        return Promise.resolve(cached).then(function (d) {
          tagCache[''] = d || { categories: [] };
          return tagCache[''];
        });
      }
    }
    var url = '/api/tags' + (key ? '?singer=' + encodeURIComponent(key) : '');
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      tagCache[key] = d || { categories: [] };
      return tagCache[key];
    }).catch(function () { return { categories: [] }; });
  }

  /** 歌手列表(审核后台 admin=1 全量),供歌曲筛选 / 新增歌曲归属选择复用 */
  var _singersCache = null;
  function loadSingersBrief() {
    if (_singersCache) return _singersCache;
    _singersCache = fetch('/api/singers?admin=1').then(function (r) { return r.json(); })
      .then(function (d) {
        var arr = Array.isArray(d) ? d : (d && Array.isArray(d.list) ? d.list : []);
        return arr.map(function (s) { return { id: s.id, name_zh: s.name_zh || '', name_en: s.name_en || '' }; });
      })
      .catch(function () { return []; });
    return _singersCache;
  }

  /** 填充「演出提交」栏目歌手筛选下拉(仅填一次;reload 清缓存后仍保留已选状态) */
  var _singerFilterReady = false;
  function ensureSingerFilter() {
    var sel = document.getElementById('review-singer');
    if (!sel || _singerFilterReady) return;
    _singerFilterReady = true;
    loadSingersBrief().then(function (list) {
      var cur = statusSinger;
      sel.innerHTML = '<option value="">全部歌手</option>';
      var found = false;
      list.forEach(function (s) {
        if (s.id === cur) found = true;
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name_zh + (s.name_en ? ' (' + s.name_en + ')' : '');
        sel.appendChild(o);
      });
      if (cur && !found) { // 歌手可能已停用,但列表里仍有其演出 → 保留该选择
        var o = document.createElement('option');
        o.value = cur; o.textContent = cur;
        sel.appendChild(o);
      }
      sel.value = cur || '';
    });
  }

  /** 目录 CRUD 后重载:先清缓存强制刷新 /api/tags,再重绘当前模块 */
  function reload() {
    tagCache = {};
    _singersCache = null;
    load();
  }

  function loadUsers(box) {
    box.innerHTML = '<p class="empty">加载中…</p>';
    Auth.request('GET', '/api/users').then(function (r) {
      if (!r.ok) {
        renderError(box, (r.data && r.data.error) || '用户列表加载失败', function () { loadUsers(box); });
        return;
      }
      var list = r.data || [];
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="empty">暂无注册用户。</p>'; return; }
      list.forEach(function (u) {
        var card = document.createElement('div');
        card.className = 'list-card user-card';
        var head = document.createElement('div');
        head.className = 'list-card__head user-card__head';

        var userIdent = document.createElement('div');
        userIdent.className = 'user-card__identity';

        if (u.is_owner) {
          var ownerBadge = document.createElement('span');
          ownerBadge.className = 'role-owner';
          ownerBadge.textContent = '站主';
          ownerBadge.title = '站点创始人,角色不可修改';
          userIdent.appendChild(ownerBadge);
        }
        if (u.role === 'banned') {
          var bannedBadge = document.createElement('span');
          bannedBadge.className = 'role-banned-badge';
          bannedBadge.textContent = '已封禁';
          userIdent.appendChild(bannedBadge);
        }
        var title = document.createElement('span');
        title.className = 'list-card__title user-card__title';
        title.textContent = u.username;
        title.title = u.username;
        userIdent.appendChild(title);
        head.appendChild(userIdent);

        // 角色分段控件(user | admin,照 geoguide):全列表可见当前角色;
        // 仅 site owner 可点另一段切换他人,自/owner 行为只读;被封禁用户不展示角色分段
        if (u.role !== 'banned') {
          head.appendChild(roleSwitch(u.role === 'admin' ? 'admin' : 'user',
            !!(me && me.super_admin && !u.is_owner && u.id !== me.id), u));
        }
        card.appendChild(head);

        var m1 = document.createElement('div');
        m1.className = 'list-card__meta user-card__created';
        m1.textContent = '注册于 ' + (u.created_at || '').slice(0, 10);
        card.appendChild(m1);

        var m2 = document.createElement('div');
        m2.className = 'list-card__meta user-card__stats';
        m2.innerHTML = '提交: 通过 <span class="user-card__stat--approved">' + (u.approved || 0) + '</span> · 待审 <span class="user-card__stat--pending">' + (u.pending || 0) + '</span> · 驳回 <span class="user-card__stat--rejected">' + (u.rejected || 0) + '</span>';
        card.appendChild(m2);

        // 操作按钮:封禁/解封 与 删除用户(纯矢量图案化,无文字/无边框/无常态底色,高对比危险色防融为一体)
        // 守卫:不可操作站主、不可操作自己;非 super_admin 不可操作其他 admin
        var canManage = !u.is_owner && (!me || u.id !== me.id) && (me && (me.super_admin || u.role !== 'admin'));
        if (canManage) {
          var act = document.createElement('div');
          act.className = 'list-card__actions list-card__actions--user';

          if (u.role === 'banned') {
            var unbanBtn = document.createElement('button');
            unbanBtn.type = 'button';
            unbanBtn.className = 'ghost-icon-btn';
            unbanBtn.title = '解除该用户的封禁状态(允许登录)';
            unbanBtn.setAttribute('aria-label', '解封用户');
            unbanBtn.innerHTML = window.Icons ? Icons.get('restore') : '解封';
            unbanBtn.addEventListener('click', function () {
              var doUnban = function () {
                unbanBtn.disabled = true;
                Auth.request('PATCH', '/api/users/' + encodeURIComponent(u.id), { role: 'user' }).then(function (res) {
                  if (!res.ok) {
                    if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '解封失败', { title: '操作失败' });
                    else alert((res.data && res.data.error) || '解封失败');
                  } else if (window.AppDialog) {
                    AppDialog.toast('用户「' + u.username + '」已解封', { type: 'success' });
                  }
                  load();
                }).catch(function () {
                  if (window.AppDialog) AppDialog.alert('网络错误,请重试');
                  else alert('网络错误,请重试');
                  load();
                });
              };
              if (window.AppDialog) {
                AppDialog.confirm({
                  title: '解封用户',
                  message: '确定要解封用户「' + u.username + '」吗？',
                  confirmText: '解封'
                }).then(function (ok) { if (ok) doUnban(); });
              } else if (confirm('确定要解封用户「' + u.username + '」吗?')) {
                doUnban();
              }
            });
            act.appendChild(unbanBtn);
          } else {
            var banBtn = document.createElement('button');
            banBtn.type = 'button';
            banBtn.className = 'ghost-icon-btn ghost-icon-btn--danger';
            banBtn.title = '封禁该用户(使其无法登录并立即踢出会话)';
            banBtn.setAttribute('aria-label', '封禁用户');
            banBtn.innerHTML = window.Icons ? Icons.get('ban') : '封禁';
            banBtn.addEventListener('click', function () {
              var warn = u.role === 'admin' ? '【警告】该用户为管理员！\n\n' : '';
              var banMsg = warn + '确定要封禁用户「' + u.username + '」吗？\n\n封禁后该用户将立即被下线且无法登录。';
              var doBan = function () {
                banBtn.disabled = true;
                Auth.request('PATCH', '/api/users/' + encodeURIComponent(u.id), { role: 'banned' }).then(function (res) {
                  if (!res.ok) {
                    if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '封禁失败', { title: '操作失败' });
                    else alert((res.data && res.data.error) || '封禁失败');
                  } else if (window.AppDialog) {
                    AppDialog.toast('用户「' + u.username + '」已被封禁', { type: 'info' });
                  }
                  load();
                }).catch(function () {
                  if (window.AppDialog) AppDialog.alert('网络错误,请重试');
                  else alert('网络错误,请重试');
                  load();
                });
              };
              if (window.AppDialog) {
                AppDialog.confirm({
                  title: '封禁用户确认',
                  message: banMsg,
                  confirmText: '确认封禁',
                  danger: true
                }).then(function (ok) { if (ok) doBan(); });
              } else if (confirm(banMsg)) {
                doBan();
              }
            });
            act.appendChild(banBtn);
          }

          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'ghost-icon-btn ghost-icon-btn--danger';
          delBtn.title = '彻底删除该用户(清理其待审提交与会话,不可撤销)';
          delBtn.setAttribute('aria-label', '彻底删除用户');
          delBtn.innerHTML = window.Icons ? Icons.get('delete') : '删除';
          delBtn.addEventListener('click', function () {
            var warn = u.role === 'admin' ? '【警告】该用户为管理员！\n\n' : '';
            var promptMsg = warn + '确定要彻底删除用户「' + u.username + '」吗？\n\n' +
              '• 该操作不可撤销!\n' +
              '• 该用户的会话、收藏、未通过提交等将被彻底清理。\n' +
              '• 若该用户有已通过的公开演出,演出将保留但提交者置空。';
            var doDelUser = function () {
              delBtn.disabled = true;
              Auth.request('DELETE', '/api/users/' + encodeURIComponent(u.id)).then(function (res) {
                if (!res.ok) {
                  if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '删除失败', { title: '操作失败' });
                  else alert((res.data && res.data.error) || '删除失败');
                } else if (window.AppDialog) {
                  AppDialog.toast('用户「' + u.username + '」已被彻底删除', { type: 'info' });
                }
                load();
              }).catch(function () {
                if (window.AppDialog) AppDialog.alert('网络错误,请重试');
                else alert('网络错误,请重试');
                load();
              });
            };
            if (window.AppDialog) {
              AppDialog.confirm({
                title: '彻底删除用户确认',
                message: promptMsg,
                confirmText: '彻底删除用户',
                danger: true
              }).then(function (ok) { if (ok) doDelUser(); });
            } else if (confirm(promptMsg)) {
              doDelUser();
            }
          });
          act.appendChild(delBtn);

          card.appendChild(act);
        }

        box.appendChild(card);
      });
    }).catch(function () {
      renderError(box, '用户列表加载失败，请检查网络或重新登录', function () { loadUsers(box); });
    });
  }

  /** 角色分段控件(user | admin,照 geoguide):active 段 = 当前角色,所有人可见。
   *  interactive=false 整组只读(展示当前角色);interactive=true(仅 site owner 用于他人)
   *  点另一段即切换,后端仍校验(不能改自己/owner/最后一个 admin)。 */
  function roleSwitch(activeRole, interactive, u) {
    var g = document.createElement('div');
    g.className = 'role-switch' + (interactive ? '' : ' role-switch--static');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', '角色');
    ['user', 'admin'].forEach(function (r) {
      var active = r === activeRole;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'role-switch__seg' + (active ? ' active' : '');
      b.textContent = r;
      b.dataset.role = r;
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active) {
        b.title = '当前角色';
      } else if (!interactive) {
        b.title = '不可修改';
      } else {
        b.title = '点击将 ' + u.username + ' 设为 ' + r;
        b.addEventListener('click', function () {
          var promote = r === 'admin';
          var msg = promote
            ? '确定将「' + u.username + '」的角色提升为 admin 吗？\n\nadmin 可进入审核后台进行管理。'
            : '确定将「' + u.username + '」的角色降级为 user 吗？\n\n降级后该用户将无法再访问审核后台。';
          var doRole = function () {
            g.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
            Auth.request('PATCH', '/api/users/' + encodeURIComponent(u.id), { role: r }).then(function (res) {
              if (!res.ok) {
                if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '操作失败', { title: '操作失败' });
                else alert((res.data && res.data.error) || '操作失败');
              } else if (window.AppDialog) {
                AppDialog.toast('用户身份已更新为 ' + r, { type: 'success' });
              }
              load(); // 成功/失败都重载(失败也还原按钮)
            }).catch(function () {
              if (window.AppDialog) AppDialog.alert('网络错误,请重试');
              else alert('网络错误,请重试');
              load();
            });
          };
          if (window.AppDialog) {
            AppDialog.confirm({
              title: '修改用户身份',
              message: msg,
              confirmText: '确认修改',
              danger: !promote
            }).then(function (ok) { if (ok) doRole(); });
          } else if (confirm(msg)) {
            doRole();
          }
        });
      }
      g.appendChild(b);
    });
    return g;
  }

  /** 审计/文案里的角色小标签(HTML,调用方先 Auth.esc 名字) */
  function roleChipHtml(role) {
    var cls = role === 'admin' ? 'role-chip--admin' : (role === 'banned' ? 'role-chip--banned' : 'role-chip--user');
    return '<span class="role-chip ' + cls + '">' + role + '</span>';
  }

  /* ---------- 审计(admin 对用户角色变更,仿 geoguide Audit Log) ---------- */
  function fmtAuditTime(ts) {
    if (!ts) return '';
    // 存储为 UTC 'YYYY-MM-DD HH:MM:SS',补 Z 转本地展示
    var d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return ts;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function loadAudit(box) {
    box.hidden = false;
    box.innerHTML = '<p class="empty">加载中…</p>';
    Auth.request('GET', '/api/audit').then(function (r) {
      if (!r.ok) {
        renderError(box, (r.data && r.data.error) || '审计记录加载失败', function () { loadAudit(box); });
        return;
      }
      var logs = (r.data && r.data.logs) || [];
      box.innerHTML = '';
      if (!logs.length) { box.innerHTML = '<p class="empty">暂无审计记录。</p>'; return; }
      logs.forEach(function (e) {
        var isRename = e.action === 'change_username';
        var isDelete = e.action === 'delete_user';
        var isBan = e.action === 'set_role_banned';
        var isAdmin = e.action === 'set_role_admin';
        var isUser = e.action === 'set_role_user';

        var row = document.createElement('div');
        row.className = 'audit-row';
        var tx = document.createElement('span');
        tx.className = 'audit-row__text';
        var actor = Auth.esc(e.actor_name || '(已注销)');
        var target = Auth.esc(e.target_name || e.detail || '(已注销)');

        if (isRename) {
          tx.innerHTML = '用户名 <b>' + Auth.esc(e.detail || '(旧名未知)') + '</b> 改为 <b>' + target + '</b>';
        } else if (isDelete) {
          tx.innerHTML = '<b>' + actor + '</b> 彻底删除了用户 <b>' + target + '</b>';
        } else if (isBan) {
          tx.innerHTML = '<b>' + actor + '</b> 将 <b>' + target + '</b> 封禁';
        } else if (isAdmin) {
          tx.innerHTML = '<b>' + actor + '</b> 将 <b>' + target + '</b> 提升为 ' + roleChipHtml('admin');
        } else if (isUser) {
          tx.innerHTML = '<b>' + actor + '</b> 将 <b>' + target + '</b> 设为 ' + roleChipHtml('user');
        } else {
          tx.innerHTML = '<b>' + actor + '</b> 对 <b>' + target + '</b> 执行了 ' + Auth.esc(e.action);
        }
        var t = document.createElement('span');
        t.className = 'audit-row__time';
        t.textContent = fmtAuditTime(e.created_at);
        row.appendChild(tx); row.appendChild(t);
        box.appendChild(row);
      });
    }).catch(function () {
      renderError(box, '审计记录加载失败，请检查网络或重新登录', function () { loadAudit(box); });
    });
  }

  /** 卡片 tags 拆分:「类型/年份」是字段影子不展示;「歌曲」折进下拉,其余平铺(2026-09-07)。
   *  返回 { songs:[], others:[] },均不含自动类别。 */
  function splitChips(p) {
    var songs = [], others = [];
    (p.tags || []).forEach(function (t) {
      if (t.category_name === '类型' || t.category_name === '年份') return;
      if (t.category_name === '歌曲') songs.push(t); else others.push(t);
    });
    return { songs: songs, others: others };
  }
  function chipHtml(t) {
    return '<span class="tag-chip static">' + Auth.esc(t.name) + '</span>';
  }

  /** 秒 → mm:ss / h:mm:ss(审核页逐曲时间展示,优先复用 TrackTime.format) */
  function fmtSec(sec) {
    if (sec == null) return '—';
    if (window.TrackTime && window.TrackTime.format) {
      var formatted = window.TrackTime.format(sec);
      return formatted || '—';
    }
    var t = Math.floor(sec);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  function buildCard(p, box) {
    var card = document.createElement('div');
    card.className = 'list-card';
    var links = (p.links || []).map(function (l) {
      return '<a class="mini-link" href="' + Auth.esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + Auth.esc(l.label) + (l.is_full ? ' 〔整场〕' : '') + '</a>';
    }).join('');
    // 歌曲 chip 折进「曲目 · N 首」下拉,其余非自动标签仍平铺 —— 卡片变短(R7)
    var spl = splitChips(p);
    var otherChips = spl.others.map(chipHtml).join('');
    var songsFold = spl.songs.length
      ? '<details class="list-card__songs-fold"><summary>曲目 · ' + spl.songs.length + ' 首</summary>' +
        '<div class="list-card__links">' + spl.songs.map(chipHtml).join('') + '</div></details>'
      : '';
    var tracks = '';
    if (p.tracks && p.tracks.length) {
      var trackChips = p.tracks.map(function (t) {
        return '<span class="tag-chip static">' + Auth.esc(fmtSec(t.seconds)) + ' ' + Auth.esc(t.name) + '</span>';
      }).join('');
      tracks = '<details class="list-card__tracks-fold"><summary>逐曲时间 · ' + p.tracks.length + ' 首</summary>' +
        '<div class="list-card__tracks-scroll">' + trackChips + '</div></details>';
    }
    var delLine = '';
    if (statusSel === 'trash') {
      var _raw = String(p.deleted_at || '');
      var _dd = String(_raw).slice(0, 16);
      var _dt = _raw ? new Date(_raw.replace(' ', 'T') + 'Z') : null;
      if (_dt && !isNaN(_dt)) {
        function _p2(n) { return (n < 10 ? '0' : '') + n; }
        _dd = _dt.getFullYear() + '-' + _p2(_dt.getMonth() + 1) + '-' + _p2(_dt.getDate()) + ' ' + _p2(_dt.getHours()) + ':' + _p2(_dt.getMinutes());
      }
      var _orig = p.status === 'approved' ? '已通过' : p.status === 'rejected' ? '已驳回' : '待审核';
      delLine = '<div class="list-card__del">删除于 ' + Auth.esc(_dd) + ' · 原' + _orig + '</div>';
    }
    // 修改 / 删除:次级图标按钮(右侧),弱于主操作 通过/驳回。已通过/待审核均可「修改」。
    function miniDel() {
      return '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="del" data-id="' + Auth.esc(p.id) + '" title="删除此条(进回收站)" aria-label="删除">' +
        (window.Icons ? Icons.get('delete') : '删除') + '</button>';
    }
    function miniShare() {
      return '<button type="button" class="ghost-icon-btn" data-act="share" title="复制演出链接" aria-label="复制演出链接">' +
        (window.Icons ? Icons.get('share') : '分享') + '</button>';
    }
    function miniEdit() {
      return '<button type="button" class="ghost-icon-btn" data-tags="' + Auth.esc(p.id) + '" title="修改形式/年份/曲目" aria-label="修改">' +
        (window.Icons ? Icons.get('edit') : '修改') + '</button>';
    }
    var actions = '';
    var sub = '';
    if (statusSel === 'pending') {
      actions = '<button type="button" class="btn btn--sm" data-act="approve" data-id="' + Auth.esc(p.id) + '">通过</button> ' +
                '<button type="button" class="btn btn--ghost btn--sm" data-act="reject" data-id="' + Auth.esc(p.id) + '">驳回</button>';
      sub = miniEdit() + miniDel();
    } else if (statusSel === 'approved') {
      sub = miniShare() + miniEdit() + miniDel();
    } else if (statusSel === 'rejected') {
      sub = miniDel();
    } else if (statusSel === 'trash') {
      actions = '<button type="button" class="ghost-icon-btn" data-act="restore" data-id="' + Auth.esc(p.id) + '" title="恢复" aria-label="恢复">' +
                  (window.Icons ? Icons.get('restore') : '恢复') + '</button> ' +
                '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="purge" data-id="' + Auth.esc(p.id) + '" title="彻底删除" aria-label="彻底删除">' +
                  (window.Icons ? Icons.get('delete') : '彻底删除') + '</button>';
    }
    var chk = statusSel === 'pending'
      ? '<input type="checkbox" class="review-item__checkbox" data-id="' + Auth.esc(p.id) + '" aria-label="选择此条批量操作">'
      : '';
    card.innerHTML =
      '<div class="list-card__head">' +
        '<div class="list-card__head-left">' +
          chk +
          (p.is_draft ? '<span class="status status--draft">草稿修改</span>' : '') +
          (p.submitter ? ' <span class="list-card__submitter" title="提交人: ' + Auth.esc(p.submitter) + '">by ' + Auth.esc(p.submitter) + '</span>' : '') +
        '</div>' +
        '<span class="list-card__year">' + Auth.esc(p.year) + '</span>' +
      '</div>' +
      '<div class="list-card__title">' + Auth.esc(p.title) + '</div>' +
      '<div class="list-card__meta">' + Auth.esc(p.city) + (p.venue ? ' · ' + Auth.esc(p.venue) : '') + (p.type ? ' <span class="badge-type" data-type="' + Auth.esc(p.type) + '">' + Auth.esc(p.type) + '</span>' : '') + '</div>' +
      (p.is_draft ? '<div class="list-card__draft-origin" title="修改目标: ' + Auth.esc(p.original_title || '') + (p.original_city ? ' (' + Auth.esc(p.original_city) + ')' : '') + '">' +
        '<span class="list-card__draft-arrow">↳</span> <span class="list-card__draft-text">' + Auth.esc(p.original_title || '') + (p.original_city ? ' · ' + Auth.esc(p.original_city) : '') + '</span>' +
      '</div>' : '') +
      (delLine) +
      (otherChips ? '<div class="list-card__links">' + otherChips + '</div>' : '') +
      (songsFold) +
      (p.note ? '<div class="list-card__meta">' + Auth.esc(p.note) + '</div>' : '') +
      (p.reject_reason ? '<div class="list-card__reject">原因:' + Auth.esc(p.reject_reason) + '</div>' : '') +
      (links ? '<div class="list-card__links">' + links + '</div>' : '') +
      (tracks ? tracks : '') +
      '<div class="list-card__actions">' + actions + (sub ? '<span class="list-card__actions-sub">' + sub + '</span>' : '') + '</div>' +
      '<div class="perf-tag-editor" data-for="' + Auth.esc(p.id) + '" hidden></div>';
    box.appendChild(card);

    Array.prototype.forEach.call(card.querySelectorAll('[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        var id = btn.getAttribute('data-id') || (p && p.id);
        if (act === 'share') {
          var shareUrl = window.ShareUtils
            ? window.ShareUtils.buildPerformanceShareUrl({ id: p.id, singer: p.singer })
            : (window.location.origin + '/singer/' + encodeURIComponent(p.singer || 'david-tao') + '?perf=' + encodeURIComponent(p.id));
          if (window.ShareUtils) {
            window.ShareUtils.copyWithFeedback(btn, shareUrl, '演出链接已复制');
          }
          return;
        }
        var base = '/api/review/' + encodeURIComponent(id);
        if (act === 'approve' || act === 'reject') {
          if (act === 'reject') {
            var doReject = function (reason) {
              if (reason === null) return;
              var body = { action: 'reject', reject_reason: reason || '未说明' };
              Auth.request('PATCH', base, body).then(function (r) {
                if (r.ok) {
                  if (window.AppDialog) AppDialog.toast('已驳回该条提交', { type: 'info' });
                  load();
                } else {
                  if (window.AppDialog) AppDialog.alert(r.data.error || '操作失败', { title: '操作失败' });
                  else alert(r.data.error || '操作失败');
                }
              });
            };
            if (window.AppDialog) {
              AppDialog.prompt({
                title: '驳回提交',
                message: '请输入驳回原因，将反馈给提交者：',
                placeholder: '如：视频链接已失效，或演出时间场馆不准确...',
                multiline: true,
                confirmText: '确认驳回',
                danger: true
              }).then(doReject);
            } else {
              doReject(prompt('驳回原因:'));
            }
            return;
          }
          // act === 'approve'
          Auth.request('PATCH', base, { action: 'approve' }).then(function (r) {
            if (r.ok) {
              if (window.AppDialog) AppDialog.toast('已审核通过并入库', { type: 'success' });
              load();
            } else {
              if (window.AppDialog) AppDialog.alert(r.data.error || '操作失败', { title: '操作失败' });
              else alert(r.data.error || '操作失败');
            }
          });
          return;
        }
        var msg;
        var dlgTitle = '';
        var isDanger = false;
        if (act === 'del') {
          dlgTitle = '移入回收站';
          msg = '删除「' + p.title + '」(' + p.city + ')? 该条将下架进回收站, 7 天内可恢复, 逾期自动彻底清除。';
          isDanger = true;
        } else if (act === 'restore') {
          dlgTitle = '恢复提交';
          msg = '确定恢复「' + p.title + '」吗？';
        } else if (act === 'purge') {
          dlgTitle = '彻底删除';
          msg = '彻底删除「' + p.title + '」？此操作不可恢复，将连同其关联的新歌提案一并清除。';
          isDanger = true;
        }
        var doAction = function () {
          var req = act === 'del' ? Auth.request('DELETE', base) : Auth.request('POST', base + '/' + act, {});
          req.then(function (r) {
            if (r.ok) {
              if (window.AppDialog) AppDialog.toast(act === 'del' ? '已移入回收站' : (act === 'restore' ? '已恢复' : '已彻底删除'), { type: 'info' });
              load();
            } else {
              if (window.AppDialog) AppDialog.alert(r.data.error || '操作失败', { title: '操作失败' });
              else alert(r.data.error || '操作失败');
            }
          });
        };
        if (window.AppDialog && msg) {
          AppDialog.confirm({
            title: dlgTitle,
            message: msg,
            confirmText: dlgTitle,
            danger: isDanger
          }).then(function (ok) { if (ok) doAction(); });
        } else if (msg && confirm(msg)) {
          doAction();
        }
      });
    });

    var tagsBtn = card.querySelector('[data-tags]');
    if (tagsBtn) {
      tagsBtn.addEventListener('click', function () { toggleTagEditor(card, p); });
    }

    var chkEl = card.querySelector('.review-item__checkbox');
    if (chkEl) {
      chkEl.addEventListener('change', function () {
        var id = chkEl.getAttribute('data-id');
        if (chkEl.checked) batchSel[id] = true; else delete batchSel[id];
        syncSelAll();
        updateBatchBar();
      });
    }
  }

  function loadList(status, box) {
    box.innerHTML = '<p class="empty">加载中…</p>';
    var p;
    // 预载仅覆盖「待审核·全部歌手」默认视图;带歌手筛选或其它状态走强制新拉
    if (!statusSinger && _preload['review:' + status]) { p = Promise.resolve(_preload['review:' + status]); delete _preload['review:' + status]; }
    else {
      // 刷新按钮/手动切换:强制新拉(缓存破坏)
      p = fetch('/api/review?status=' + encodeURIComponent(status) +
          (statusSinger ? '&singer=' + encodeURIComponent(statusSinger) : '') +
          '&_=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.json(); });
    }
    p.then(function (list) {
      if (!Array.isArray(list)) {
        renderError(box, (list && list.error) || '演出列表加载失败', function () { loadList(status, box); });
        setSelAllVisible(false);
        updateBatchBar();
        return;
      }
      box.innerHTML = '';
      batchSel = {};
      if (!list.length) {
        box.innerHTML = '<p class="empty">该状态暂无条目。</p>';
        setSelAllVisible(false);
        updateBatchBar();
        return;
      }
      list.forEach(function (p) { buildCard(p, box); });
      setSelAllVisible(status === 'pending');
      updateBatchBar();
    }).catch(function () {
      renderError(box, '演出列表加载失败，请检查网络或重新登录', function () { loadList(status, box); });
    });
  }

  /* ---------- 已通过演出编辑器:年份/形式可改 + 歌曲按歌手下拉 + 非自动标签 chips ---------- */
  var TYPE_OPTIONS = ['演唱会', '音乐节', '歌友会', '签售', '其他'];
  function typeOptionsHtml(currentType) {
    var cur = String(currentType == null ? '' : currentType);
    var set = TYPE_OPTIONS.slice();
    if (cur && set.indexOf(cur) < 0) set.push(cur); // 历史遗留形式值保留,避免“不改也存不回”
    return set.map(function (t) {
      return '<option value="' + Auth.esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + Auth.esc(t) + '</option>';
    }).join('');
  }

  function toggleTagEditor(card, perf) {
    var box = card.querySelector('.perf-tag-editor');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.innerHTML = '<p class="empty">加载中…</p>';
    box.hidden = false;
    // 歌曲身份=(歌手,歌名):只拉该演出歌手的目录,后端会把「歌曲」类别收窄为本歌手已收录歌
    loadCatalog(perf.singer).then(function (cat) {
      var cats = cat.categories || [];
      var SONG = '歌曲';
      var currentTags = {};
      var songSel = {}; // 已选歌曲 tagId -> name(默认预填该场已关联歌曲)
      (perf.tags || []).forEach(function (t) {
        currentTags[t.id] = true;
        if (t.category_name === SONG) songSel[t.id] = t.name;
      });
      var songCatalog = [];
      var otherCats = [];
      cats.forEach(function (c) {
        if (c.name === SONG) songCatalog = c.tags || [];
        else if (c.name !== '类型' && c.name !== '年份') otherCats.push(c); // 自动类别不展示(R1)
      });

      var html = '';
      // 1) 年份 / 形式:自动「类型/年份」标签是字段的影子,这里直接改字段
      html += '<div class="perf-fields">' +
        '<label class="field"><span>年份</span>' +
          '<input type="number" min="1900" max="2100" class="input" id="pe-year" value="' + Auth.esc(String(perf.year != null ? perf.year : '')) + '"></label>' +
        '<label class="field"><span>形式</span>' +
          '<select class="input" id="pe-type">' + typeOptionsHtml(perf.type) + '</select></label>' +
        '</div>';
      // 2) 歌曲:已选 chips(可移除)+ 下拉添加,不把全部歌曲平铺成 chip 墙(R3)
      html += '<div class="tag-group"><span class="tag-group__name">歌曲(本歌手)</span>' +
        '<div class="perf-songs__picked" id="pe-song-picked"></div>' +
        '<div class="perf-songs__addrow">' +
          '<select class="input song-add" id="pe-song-add"><option value="">＋ 从本歌手已收录歌添加…</option></select>' +
          '<span class="list-card__meta" id="pe-song-msg"></span>' +
        '</div></div>';
      // 3) 其余普通类别 chips 切换
      otherCats.forEach(function (c) {
        if (!c.tags || !c.tags.length) return;
        html += '<div class="tag-group"><span class="tag-group__name">' + Auth.esc(c.name) + '</span><div class="tag-chips">';
        (c.tags || []).forEach(function (tag) {
          html += '<button type="button" class="tag-chip' + (currentTags[tag.id] ? ' active' : '') + '" data-tag="' + Auth.esc(tag.id) + '">' + Auth.esc(tag.name) + '</button>';
        });
        html += '</div></div>';
      });
      html += '<div class="tag-manager__row">' +
        '<button type="button" class="btn btn--sm" data-save="1">保存</button> ' +
        '<button type="button" class="btn btn--ghost btn--sm" data-cancel="1">取消</button></div>';
      box.innerHTML = html;

      var pickedEl = box.querySelector('#pe-song-picked');
      var addSel = box.querySelector('#pe-song-add');
      var msgEl = box.querySelector('#pe-song-msg');
      function renderPicked() {
        pickedEl.innerHTML = '';
        Object.keys(songSel).forEach(function (id) {
          var chip = document.createElement('span');
          chip.className = 'tag-chip active perf-song-chip';
          chip.textContent = songSel[id];
          var x = document.createElement('button');
          x.type = 'button';
          x.className = 'perf-song-chip__x';
          // R12:图标一律内联 SVG,不用 Unicode '×' 充当图标
          x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';
          x.setAttribute('aria-label', '移出此场');
          x.title = '移出此场';
          x.addEventListener('click', function () { delete songSel[id]; renderPicked(); renderAddOptions(); });
          chip.appendChild(x);
          pickedEl.appendChild(chip);
        });
      }
      function renderAddOptions() {
        addSel.innerHTML = '<option value="">＋ 从本歌手已收录歌添加…</option>';
        var rest = songCatalog.filter(function (t) { return !songSel[t.id]; });
        rest.forEach(function (t) {
          var o = document.createElement('option');
          o.value = t.id;
          o.textContent = t.name;
          addSel.appendChild(o);
        });
        if (rest.length) msgEl.textContent = '';
        else if (Object.keys(songSel).length) msgEl.textContent = '该歌手可加的歌已全部选入';
        else msgEl.textContent = '该歌手暂无已收录歌曲(可到标签管理添加)';
      }
      addSel.addEventListener('change', function () {
        var id = addSel.value;
        if (!id) return;
        var t = songCatalog.filter(function (x) { return x.id === id; })[0];
        if (t) { songSel[id] = t.name; renderPicked(); }
        renderAddOptions();
      });
      renderPicked();
      renderAddOptions();

      // 其余类别 chips 切换(仅 .tag-chips 内、非歌曲非自动;歌曲 chips 在 picked 区另管)
      Array.prototype.forEach.call(box.querySelectorAll('.tag-chips .tag-chip'), function (b) {
        b.addEventListener('click', function () { b.classList.toggle('active'); });
      });
      box.querySelector('[data-save]').addEventListener('click', function () {
        var ids = [];
        Array.prototype.forEach.call(box.querySelectorAll('.tag-chips .tag-chip.active'), function (b) {
          var tagId = b.getAttribute('data-tag');
          if (tagId) ids.push(tagId);
        });
        Object.keys(songSel).forEach(function (id) { ids.push(id); });
        var y = Number(box.querySelector('#pe-year').value);
        if (!(Number.isFinite(y) && y >= 1900 && y <= 2100 && Math.floor(y) === y)) {
          alert('年份需在 1900-2100'); return;
        }
        var body = { tag_ids: ids };
        if (y !== Number(perf.year)) body.year = y;
        var typeV = box.querySelector('#pe-type').value;
        if (typeV !== String(perf.type || '')) body.type = typeV;
        Auth.request('PATCH', '/api/performances/' + encodeURIComponent(perf.id) + '/tags', body).then(function (r) {
          if (r.ok) reload(); else alert(r.data.error || '保存失败');
        });
      });
      // 取消:收起面板、丢弃未保存改动(再开会重拉目录重建)
      box.querySelector('[data-cancel]').addEventListener('click', function () {
        box.hidden = true;
      });
    }).catch(function () { box.innerHTML = '<p class="empty">标签目录加载失败。</p>'; });
  }

  /* ---------- 标签管理 ---------- */
  function populateCatSelect(sel, cats) {
    if (!sel) return;
    sel.innerHTML = '';
    (cats || []).forEach(function (cat) {
      if (cat.name === '类型' || cat.name === '年份' || cat.name === '歌曲') return;
      var o = document.createElement('option');
      o.value = cat.id;
      o.textContent = cat.name;
      sel.appendChild(o);
    });
  }

  function populateSingerSelect(sel, singers, placeholder) {
    if (!sel) return;
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholder || '请选择歌手';
    sel.appendChild(ph);
    (singers || []).forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name_zh + (s.name_en ? ' · ' + s.name_en : '');
      sel.appendChild(o);
    });
  }

  /** 「已有类别与标签」:非歌曲、非内置类别(自动「类型/年份」与「歌曲」各自独立,不在此平铺) */
  function renderOtherCategories(container, cats) {
    container.innerHTML = '';
    var list = (cats || []).filter(function (c) {
      return c.name !== '歌曲' && c.name !== '类型' && c.name !== '年份';
    });
    if (!list.length) { container.innerHTML = '<p class="empty">暂无其它类别。</p>'; return; }
    list.forEach(function (cat) {
      var wrap = document.createElement('div');
      wrap.className = 'tag-manager__cat';
      var row = document.createElement('div');
      row.className = 'tag-manager__row';
      var nameEl = document.createElement('input');
      nameEl.className = 'input';
      nameEl.value = cat.name;
      nameEl.style.flex = '1';
      row.appendChild(nameEl);
      var rn = document.createElement('button');
      rn.type = 'button'; rn.className = 'ghost-icon-btn';
      rn.title = '重命名类别「' + cat.name + '」';
      rn.setAttribute('aria-label', '重命名类别');
      rn.innerHTML = window.Icons ? Icons.get('edit') : '改名';
      rn.addEventListener('click', function () {
        var v = nameEl.value.trim();
        if (!v || v === cat.name) return;
        Auth.request('PATCH', '/api/tags', { action: 'rename_category', id: cat.id, name: v }).then(function (r) {
          if (r.ok) reload(); else alert(r.data.error || '重命名失败');
        });
      });
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'ghost-icon-btn ghost-icon-btn--danger';
      del.title = '删除类别「' + cat.name + '」及其全部标签';
      del.setAttribute('aria-label', '删除类别');
      del.innerHTML = window.Icons ? Icons.get('delete') : '删除';
      del.addEventListener('click', function () {
        var doDelCat = function () {
          Auth.request('DELETE', '/api/tags?type=category&id=' + encodeURIComponent(cat.id)).then(function (r) {
            if (r.ok) {
              if (window.AppDialog) AppDialog.toast('类别「' + cat.name + '」已删除', { type: 'info' });
              reload();
            } else {
              if (window.AppDialog) AppDialog.alert(r.data.error || '删除失败', { title: '操作失败' });
              else alert(r.data.error || '删除失败');
            }
          });
        };
        if (window.AppDialog) {
          AppDialog.confirm({
            title: '删除类别确认',
            message: '确定删除类别「' + cat.name + '」及其全部标签？此操作不可逆。',
            confirmText: '删除类别',
            danger: true
          }).then(function (ok) { if (ok) doDelCat(); });
        } else if (confirm('删除类别「' + cat.name + '」及其全部标签?')) {
          doDelCat();
        }
      });
      row.appendChild(rn); row.appendChild(del);
      wrap.appendChild(row);

      (cat.tags || []).forEach(function (tag) {
        var trow = document.createElement('div');
        trow.className = 'tag-manager__row tag-manager__tag';
        var input = document.createElement('input');
        input.className = 'input';
        input.value = tag.name;
        input.style.maxWidth = '260px';
        trow.appendChild(input);
        var rn2 = document.createElement('button');
        rn2.type = 'button'; rn2.className = 'ghost-icon-btn';
        rn2.title = '重命名标签「' + tag.name + '」';
        rn2.setAttribute('aria-label', '重命名标签');
        rn2.innerHTML = window.Icons ? Icons.get('edit') : '改名';
        rn2.addEventListener('click', function () {
          var v = input.value.trim();
          if (!v || v === tag.name) return;
          Auth.request('PATCH', '/api/tags', { action: 'rename_tag', id: tag.id, name: v }).then(function (r) {
            if (r.ok) reload(); else alert(r.data.error || '改名失败');
          });
        });
        trow.appendChild(rn2);
        var aliasInput = document.createElement('input');
        aliasInput.className = 'input tag-alias-input';
        aliasInput.placeholder = '同标签别名,顿号分隔';
        aliasInput.title = '同标签其他写法,顿号/换行分隔;批准同名提案时自动并入该标签';
        aliasInput.value = (tag.aliases || []).join('、');
        aliasInput.maxLength = 300;
        trow.appendChild(aliasInput);
        var saveAlias = document.createElement('button');
        saveAlias.type = 'button'; saveAlias.className = 'ghost-icon-btn ghost-icon-btn--ok';
        saveAlias.innerHTML = window.Icons ? Icons.get('check') : '存';
        saveAlias.title = '保存上方别名(顿号分隔)';
        saveAlias.setAttribute('aria-label', '保存别名');
        var saveAliasNow = function () {
          var arr = aliasInput.value.split(/[、\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
          saveAlias.disabled = true;
          Auth.request('PATCH', '/api/tags', { action: 'set_aliases', id: tag.id, aliases: arr }).then(function (r) {
            saveAlias.disabled = false;
            if (r.ok) reload(); else alert(r.data.error || '保存别名失败');
          });
        };
        saveAlias.addEventListener('click', saveAliasNow);
        aliasInput.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); saveAliasNow(); }
        });
        trow.appendChild(saveAlias);
        var del2 = document.createElement('button');
        del2.type = 'button'; del2.className = 'ghost-icon-btn ghost-icon-btn--danger';
        del2.title = '删除标签「' + tag.name + '」';
        del2.setAttribute('aria-label', '删除标签');
        del2.innerHTML = window.Icons ? Icons.get('delete') : '删';
        del2.addEventListener('click', function () {
          var doDelTag = function () {
            Auth.request('DELETE', '/api/tags?type=tag&id=' + encodeURIComponent(tag.id)).then(function (r) {
              if (r.ok) {
                if (window.AppDialog) AppDialog.toast('标签「' + tag.name + '」已删除', { type: 'info' });
                reload();
              } else {
                if (window.AppDialog) AppDialog.alert(r.data.error || '删除失败', { title: '操作失败' });
                else alert(r.data.error || '删除失败');
              }
            });
          };
          if (window.AppDialog) {
            AppDialog.confirm({
              title: '删除标签确认',
              message: '确定删除标签「' + tag.name + '」？',
              confirmText: '删除',
              danger: true
            }).then(function (ok) { if (ok) doDelTag(); });
          } else if (confirm('删除标签「' + tag.name + '」?')) {
            doDelTag();
          }
        });
        trow.appendChild(del2);
        wrap.appendChild(trow);
      });
      container.appendChild(wrap);
    });
  }

  /* ---------- 歌曲管理一级模块 (仿照「我的提交」UI 规范: 歌手下拉筛选 + 放大镜搜索框 + 4 列网格) ---------- */
  function loadSongManager() {
    var box = document.getElementById('song-manager');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<p class="empty">歌曲加载中…</p>';

    var selectedSongIds = {};
    var currentAllTags = [];
    var currentVisibleTags = [];
    var songCatId = null;
    var singersList = [];

    // 并行拉取目录与歌手
    Promise.all([loadCatalog(''), loadSingersBrief()]).then(function (res) {
      var cat = res[0] || {};
      singersList = res[1] || [];

      var songCat = null;
      (cat.categories || []).forEach(function (c) {
        if (c.name === '歌曲') songCat = c;
      });
      songCatId = songCat ? songCat.id : null;
      currentAllTags = (songCat && songCat.tags) ? songCat.tags : [];

      renderUI();
    }).catch(function () {
      renderError(box, '歌曲列表加载失败，请检查网络或重新登录', function () { loadSongManager(); });
    });

    function renderUI() {
      box.innerHTML =
        '<!-- 新增歌曲折叠面板 -->' +
        '<div class="song-add-panel" id="song-add-panel" hidden>' +
          '<div class="song-add-panel__head">' +
            '<span>添加新歌曲</span>' +
            '<button type="button" class="modal-close" id="song-add-close" aria-label="关闭">' +
              (window.Icons ? Icons.get('close') : '×') +
            '</button>' +
          '</div>' +
          '<div class="song-add-panel__row">' +
            '<label><span>归属歌手：</span><select id="song-add-singer" class="input"></select></label>' +
          '</div>' +
          '<textarea id="song-add-names" class="input" placeholder="输入歌曲名，每行一首，或用逗号、顿号分隔（单次最多 50 首）..."></textarea>' +
          '<div class="song-add-panel__actions">' +
            '<button type="button" class="btn btn--sm" id="song-add-submit">保存添加</button>' +
            '<button type="button" class="btn btn--ghost btn--sm" id="song-add-cancel">取消</button>' +
          '</div>' +
        '</div>' +
        '<!-- 工具栏: 歌手筛选 + 搜索框 + 批量操作 + 添加歌曲 -->' +
        '<div class="song-filter-row">' +
          '<div class="filter-dropdown" id="song-singer-dropdown">' +
            '<button type="button" class="filter-dropdown__btn" id="song-singer-btn" aria-haspopup="listbox" aria-expanded="false">' +
              '<span id="song-singer-label">全部歌手</span>' +
              '<span class="filter-dropdown__arrow">▼</span>' +
            '</button>' +
            '<div class="filter-dropdown__menu" id="song-singer-menu" role="listbox" hidden></div>' +
          '</div>' +
          '<div class="searchbox">' +
            '<span class="searchbox__icon">' + ((window.ICONS && ICONS.svg) ? ICONS.svg('search', 18) : (window.Icons ? Icons.get('search') : '🔍')) + '</span>' +
            '<input type="text" class="searchbox__input" id="song-search-input" placeholder="搜索歌曲或别名..." value="' + Auth.esc(songSearchKeyword || '') + '" />' +
            '<button type="button" class="searchbox__clear" id="song-search-clear" ' + (songSearchKeyword ? '' : 'hidden') + ' aria-label="清空搜索">' +
              ((window.ICONS && ICONS.svg) ? ICONS.svg('close', 14) : (window.Icons ? Icons.get('close') : '×')) +
            '</button>' +
          '</div>' +
          '<label class="song-select-all-wrap">' +
            '<input type="checkbox" id="song-select-all" />' +
            '<span>全选</span>' +
          '</label>' +
          '<button type="button" class="btn btn--danger btn--sm song-batch-del" id="song-batch-del" hidden>' +
            (window.Icons ? Icons.get('delete') : '') +
            '<span id="song-batch-del-text">批量删除</span>' +
          '</button>' +
          '<button type="button" class="btn btn--sm btn--ghost" id="song-toggle-add-btn">' +
            '+ 添加歌曲' +
          '</button>' +
          '<span class="mine-count" id="song-count-meta">共 ' + currentAllTags.length + ' 首</span>' +
        '</div>' +
        '<!-- 4 列歌曲卡片网格 -->' +
        '<div class="song-grid" id="song-grid"></div>';

      // 绑定添加面板
      var addPanel = box.querySelector('#song-add-panel');
      var toggleAddBtn = box.querySelector('#song-toggle-add-btn');
      var addCloseBtn = box.querySelector('#song-add-close');
      var addCancelBtn = box.querySelector('#song-add-cancel');
      var addSubmitBtn = box.querySelector('#song-add-submit');
      var addSingerSel = box.querySelector('#song-add-singer');
      var addNamesInp = box.querySelector('#song-add-names');

      populateSingerSelect(addSingerSel, singersList, '请选择归属歌手');
      if (songFilterSinger) addSingerSel.value = songFilterSinger;

      function openAddPanel() {
        if (!songCatId) {
          if (window.AppDialog) AppDialog.alert('未找到「歌曲」分类，请先在标签管理中确认', { title: '提示' });
          return;
        }
        if (songFilterSinger) addSingerSel.value = songFilterSinger;
        addPanel.hidden = false;
        addNamesInp.focus();
      }
      function closeAddPanel() {
        addPanel.hidden = true;
        addNamesInp.value = '';
      }

      toggleAddBtn.addEventListener('click', function () {
        if (addPanel.hidden) openAddPanel(); else closeAddPanel();
      });
      addCloseBtn.addEventListener('click', closeAddPanel);
      addCancelBtn.addEventListener('click', closeAddPanel);

      addSubmitBtn.addEventListener('click', function () {
        var singerId = addSingerSel.value;
        if (!singerId) {
          if (window.AppDialog) AppDialog.alert('请先选择归属歌手', { title: '提示' });
          else alert('请先选择归属歌手');
          return;
        }
        var raw = addNamesInp.value.trim();
        var names = raw.split(/[\n,，、]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 50);
        if (!names.length) {
          if (window.AppDialog) AppDialog.alert('请填写至少一个歌曲名', { title: '提示' });
          else alert('请填写至少一个歌曲名');
          return;
        }
        addSubmitBtn.disabled = true;
        Auth.request('POST', '/api/tags', {
          action: 'create_tags_batch',
          category_id: songCatId,
          names: names,
          singer_id: singerId
        }).then(function (r) {
          addSubmitBtn.disabled = false;
          if (r.ok) {
            if (window.AppDialog && AppDialog.toast) AppDialog.toast('已成功添加 ' + names.length + ' 首歌曲', { type: 'success' });
            closeAddPanel();
            reload();
          } else {
            if (window.AppDialog) AppDialog.alert(r.data.error || '添加失败', { title: '操作失败' });
            else alert(r.data.error || '添加失败');
          }
        }).catch(function () {
          addSubmitBtn.disabled = false;
          if (window.AppDialog) AppDialog.alert('网络错误，请重试');
        });
      });

      // 初始化歌手下拉菜单
      initSingerDropdown();

      // 初始化搜索框
      initSearchBox();

      // 初始化全选与批量删除
      initBatchToolbar();

      // 渲染网格
      renderGrid();
    }

    function initSingerDropdown() {
      var dropdown = box.querySelector('#song-singer-dropdown');
      var btn = box.querySelector('#song-singer-btn');
      var label = box.querySelector('#song-singer-label');
      var menu = box.querySelector('#song-singer-menu');

      // 计算每个歌手的歌曲数
      var singerCounts = {};
      currentAllTags.forEach(function (t) {
        var sid = t.singer_id || 'unknown';
        singerCounts[sid] = (singerCounts[sid] || 0) + 1;
      });

      var currentSingerObj = singersList.filter(function (s) { return s.id === songFilterSinger; })[0];
      label.textContent = currentSingerObj ? currentSingerObj.name_zh : (songFilterSinger ? songFilterSinger : '全部歌手');

      menu.innerHTML = '';
      var allItem = document.createElement('div');
      allItem.className = 'filter-dropdown__item' + (!songFilterSinger ? ' is-selected' : '');
      allItem.innerHTML = '<span>全部歌手</span><span class="filter-dropdown__count">' + currentAllTags.length + '</span>';
      allItem.addEventListener('click', function () {
        songFilterSinger = '';
        label.textContent = '全部歌手';
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        selectedSongIds = {};
        renderGrid();
      });
      menu.appendChild(allItem);

      singersList.forEach(function (s) {
        var count = singerCounts[s.id] || 0;
        var item = document.createElement('div');
        item.className = 'filter-dropdown__item' + (songFilterSinger === s.id ? ' is-selected' : '');
        item.innerHTML = '<span>' + Auth.esc(s.name_zh) + '</span><span class="filter-dropdown__count">' + count + '</span>';
        item.addEventListener('click', function () {
          songFilterSinger = s.id;
          label.textContent = s.name_zh;
          menu.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
          selectedSongIds = {};
          renderGrid();
        });
        menu.appendChild(item);
      });

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isHidden = menu.hidden;
        menu.hidden = !isHidden;
        btn.setAttribute('aria-expanded', String(isHidden));
      });

      document.addEventListener('click', function (e) {
        if (!dropdown.contains(e.target) && !menu.hidden) {
          menu.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function initSearchBox() {
      var searchInput = box.querySelector('#song-search-input');
      var searchClear = box.querySelector('#song-search-clear');
      if (!searchInput || !searchClear) return;

      function syncClear() {
        searchClear.hidden = searchInput.value === '';
      }

      searchInput.addEventListener('input', function () {
        syncClear();
        songSearchKeyword = this.value.trim();
        renderGrid();
      });

      searchClear.addEventListener('click', function () {
        searchInput.value = '';
        songSearchKeyword = '';
        syncClear();
        renderGrid();
        searchInput.focus();
      });

      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && searchInput.value) {
          searchInput.value = '';
          songSearchKeyword = '';
          syncClear();
          renderGrid();
        }
      });
    }

    function initBatchToolbar() {
      var selectAllCb = box.querySelector('#song-select-all');
      var batchDelBtn = box.querySelector('#song-batch-del');

      selectAllCb.addEventListener('change', function () {
        var check = selectAllCb.checked;
        currentVisibleTags.forEach(function (t) {
          if (check) selectedSongIds[t.id] = true;
          else delete selectedSongIds[t.id];
        });
        renderGrid();
      });

      batchDelBtn.addEventListener('click', function () {
        var ids = Object.keys(selectedSongIds).filter(function (k) { return selectedSongIds[k]; });
        if (!ids.length) return;
        var doBatchDel = function () {
          batchDelBtn.disabled = true;
          Auth.request('PATCH', '/api/tags', { action: 'batch_delete', ids: ids }).then(function (r) {
            batchDelBtn.disabled = false;
            if (r.ok) {
              if (window.AppDialog && AppDialog.toast) AppDialog.toast('已删除选中的 ' + ids.length + ' 首歌曲', { type: 'info' });
              selectedSongIds = {};
              reload();
            } else {
              if (window.AppDialog) AppDialog.alert(r.data.error || '批量删除失败', { title: '操作失败' });
              else alert(r.data.error || '批量删除失败');
            }
          }).catch(function () {
            batchDelBtn.disabled = false;
            if (window.AppDialog) AppDialog.alert('网络错误，请重试');
          });
        };

        if (window.AppDialog && AppDialog.confirm) {
          AppDialog.confirm({
            title: '批量删除歌曲',
            message: '确定批量删除选中的 ' + ids.length + ' 首歌曲？此操作不可逆。',
            confirmText: '批量删除',
            danger: true
          }).then(function (ok) { if (ok) doBatchDel(); });
        } else if (confirm('确定批量删除选中的 ' + ids.length + ' 首歌曲？')) {
          doBatchDel();
        }
      });
    }

    function updateToolbarState() {
      var selectAllCb = box.querySelector('#song-select-all');
      var batchDelBtn = box.querySelector('#song-batch-del');
      var batchDelText = box.querySelector('#song-batch-del-text');
      var countMeta = box.querySelector('#song-count-meta');

      var selCount = Object.keys(selectedSongIds).length;
      if (selCount > 0) {
        batchDelBtn.hidden = false;
        batchDelText.textContent = '批量删除 (' + selCount + ')';
      } else {
        batchDelBtn.hidden = true;
      }

      if (!currentVisibleTags.length) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
        selectAllCb.disabled = true;
      } else {
        selectAllCb.disabled = false;
        var visibleSelCount = currentVisibleTags.filter(function (t) { return selectedSongIds[t.id]; }).length;
        if (visibleSelCount === currentVisibleTags.length) {
          selectAllCb.checked = true;
          selectAllCb.indeterminate = false;
        } else if (visibleSelCount > 0) {
          selectAllCb.checked = false;
          selectAllCb.indeterminate = true;
        } else {
          selectAllCb.checked = false;
          selectAllCb.indeterminate = false;
        }
      }

      var isFiltered = !!songFilterSinger || !!songSearchKeyword;
      if (isFiltered) {
        countMeta.textContent = '找到 ' + currentVisibleTags.length + ' / ' + currentAllTags.length + ' 首';
      } else {
        countMeta.textContent = '共 ' + currentAllTags.length + ' 首';
      }
    }

    function renderGrid() {
      var grid = box.querySelector('#song-grid');
      if (!grid) return;
      grid.innerHTML = '';

      var qStr = (songSearchKeyword || '').trim().toLowerCase();
      currentVisibleTags = currentAllTags.filter(function (t) {
        if (songFilterSinger && t.singer_id !== songFilterSinger) return false;
        if (qStr) {
          if ((t.name || '').toLowerCase().indexOf(qStr) !== -1) return true;
          if (t.aliases && t.aliases.length) {
            return t.aliases.some(function (a) { return (a || '').toLowerCase().indexOf(qStr) !== -1; });
          }
          return false;
        }
        return true;
      });

      updateToolbarState();

      if (!currentAllTags.length) {
        var emptyAll = document.createElement('p');
        emptyAll.className = 'empty';
        emptyAll.style.gridColumn = '1 / -1';
        emptyAll.textContent = '暂无歌曲，点击上方「+ 添加歌曲」开始录入。';
        grid.appendChild(emptyAll);
        return;
      }

      if (!currentVisibleTags.length) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.style.gridColumn = '1 / -1';
        empty.textContent = qStr ? '未找到匹配「' + qStr + '」的歌曲。' : '该歌手暂无歌曲。';
        grid.appendChild(empty);
        return;
      }

      currentVisibleTags.forEach(function (tag) {
        var card = document.createElement('div');
        card.className = 'song-card' + (selectedSongIds[tag.id] ? ' is-selected' : '');
        card.dataset.id = tag.id;

        // Aliases chips (仅在存在别名时渲染行，避免占位空行)
        var aliasesHtml = '';
        if (tag.aliases && tag.aliases.length) {
          aliasesHtml =
            '<div class="song-card__aliases">' +
              '<span class="song-card__alias-label">别名:</span>' +
              tag.aliases.map(function (a) {
                return '<span class="song-alias-chip" title="别名: ' + Auth.esc(a) + '">' + Auth.esc(a) + '</span>';
              }).join('') +
            '</div>';
        }

        card.innerHTML =
          '<div class="song-card__top">' +
            '<div class="song-card__title-wrap">' +
              '<input type="checkbox" class="song-card__cb" data-id="' + Auth.esc(tag.id) + '" ' + (selectedSongIds[tag.id] ? 'checked' : '') + ' aria-label="选择歌曲 ' + Auth.esc(tag.name) + '" />' +
              '<span class="song-card__name" title="' + Auth.esc(tag.name) + '">' + Auth.esc(tag.name) + '</span>' +
            '</div>' +
            '<span class="song-card__perf-count" title="关联现场演出数">' + (Number(tag.count) || 0) + ' 场</span>' +
          '</div>' +
          aliasesHtml +
          '<div class="song-card__bottom">' +
            '<span class="badge type song-card__singer" title="归属歌手">' + Auth.esc(tag.singer_name || '未归属') + '</span>' +
            '<div class="song-card__actions">' +
              '<button type="button" class="ghost-icon-btn song-card__alias-btn" title="设置同歌别名" aria-label="设置同歌别名">' + (window.Icons ? Icons.get('tag') : '别名') + '</button>' +
              '<button type="button" class="ghost-icon-btn song-card__rename-btn" title="修改歌名" aria-label="修改歌名">' + (window.Icons ? Icons.get('edit') : '修改') + '</button>' +
              '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger song-card__del-btn" title="删除歌曲" aria-label="删除歌曲">' + (window.Icons ? Icons.get('delete') : '删除') + '</button>' +
            '</div>' +
          '</div>';

        // Checkbox change
        var cb = card.querySelector('.song-card__cb');
        cb.addEventListener('change', function () {
          if (cb.checked) {
            selectedSongIds[tag.id] = true;
            card.classList.add('is-selected');
          } else {
            delete selectedSongIds[tag.id];
            card.classList.remove('is-selected');
          }
          updateToolbarState();
        });

        // Rename trigger (单处修改按钮)
        var renameBtn = card.querySelector('.song-card__rename-btn');
        var doRename = function () {
          if (window.AppDialog && AppDialog.prompt) {
            AppDialog.prompt({
              title: '修改歌名',
              message: '输入歌曲的新名称：',
              defaultValue: tag.name,
              placeholder: '歌曲名称'
            }).then(function (val) {
              if (val == null) return;
              var v = val.trim();
              if (!v || v === tag.name) return;
              Auth.request('PATCH', '/api/tags', { action: 'rename_tag', id: tag.id, name: v }).then(function (r) {
                if (r.ok) {
                  tag.name = v;
                  if (window.AppDialog && AppDialog.toast) AppDialog.toast('歌名已更新为「' + v + '」', { type: 'success' });
                  renderGrid();
                } else {
                  if (window.AppDialog) AppDialog.alert(r.data.error || '修改失败', { title: '操作失败' });
                  else alert(r.data.error || '修改失败');
                }
              });
            });
          } else {
            var v = prompt('修改歌名：', tag.name);
            if (!v || v.trim() === tag.name) return;
            v = v.trim();
            Auth.request('PATCH', '/api/tags', { action: 'rename_tag', id: tag.id, name: v }).then(function (r) {
              if (r.ok) { tag.name = v; renderGrid(); }
              else alert(r.data.error || '修改失败');
            });
          }
        };
        if (renameBtn) renameBtn.addEventListener('click', doRename);

        // Aliases trigger
        var aliasBtn = card.querySelector('.song-card__alias-btn');
        aliasBtn.addEventListener('click', function () {
          var def = (tag.aliases || []).join('、');
          if (window.AppDialog && AppDialog.prompt) {
            AppDialog.prompt({
              title: '设置同歌别名',
              message: '输入同歌别名（多个别名用顿号、或逗号分隔），批准同名提案时自动并入本歌曲：',
              defaultValue: def,
              placeholder: '如：普通朋友、David Tao Friends'
            }).then(function (val) {
              if (val == null) return;
              var arr = val.split(/[、,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
              Auth.request('PATCH', '/api/tags', { action: 'set_aliases', id: tag.id, aliases: arr }).then(function (r) {
                if (r.ok) {
                  tag.aliases = arr;
                  if (window.AppDialog && AppDialog.toast) AppDialog.toast('别名已更新', { type: 'success' });
                  renderGrid();
                } else {
                  if (window.AppDialog) AppDialog.alert(r.data.error || '保存别名失败', { title: '操作失败' });
                  else alert(r.data.error || '保存别名失败');
                }
              });
            });
          } else {
            var val = prompt('设置别名（顿号隔开）：', def);
            if (val == null) return;
            var arr = val.split(/[、,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
            Auth.request('PATCH', '/api/tags', { action: 'set_aliases', id: tag.id, aliases: arr }).then(function (r) {
              if (r.ok) { tag.aliases = arr; renderGrid(); }
              else alert(r.data.error || '保存别名失败');
            });
          }
        });

        // Delete trigger
        var delBtn = card.querySelector('.song-card__del-btn');
        delBtn.addEventListener('click', function () {
          var doDel = function () {
            Auth.request('DELETE', '/api/tags?type=tag&id=' + encodeURIComponent(tag.id)).then(function (r) {
              if (r.ok) {
                if (window.AppDialog && AppDialog.toast) AppDialog.toast('歌曲「' + tag.name + '」已删除', { type: 'info' });
                delete selectedSongIds[tag.id];
                reload();
              } else {
                if (window.AppDialog) AppDialog.alert(r.data.error || '删除失败', { title: '操作失败' });
                else alert(r.data.error || '删除失败');
              }
            });
          };
          if (window.AppDialog && AppDialog.confirm) {
            AppDialog.confirm({
              title: '删除歌曲确认',
              message: '确定删除歌曲「' + tag.name + '」？关联演出将解除该曲目标签。',
              confirmText: '删除',
              danger: true
            }).then(function (ok) { if (ok) doDel(); });
          } else if (confirm('确定删除歌曲「' + tag.name + '」？')) {
            doDel();
          }
        });

        grid.appendChild(card);
      });
    }
  }

  function loadProposals() {
    var box = document.getElementById('tm-proposals');
    if (!box) return;
    box.innerHTML = '<p class="empty">加载中…</p>';
    Auth.request('GET', '/api/tags/proposals').then(function (r) {
      if (!r.ok) {
        renderError(box, (r.data && r.data.error) || '提案加载失败', function () { loadProposals(); });
        return;
      }
      var list = (r.data && r.data.proposals) || [];
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="empty">暂无待审批提案。</p>'; return; }

      var selAll = document.createElement('label');
      selAll.className = 'tag-manager__row';
      var allCb = document.createElement('input');
      allCb.type = 'checkbox';
      var allSpan = document.createElement('span');
      allSpan.textContent = '全选(' + list.length + ')';
      selAll.appendChild(allCb); selAll.appendChild(allSpan);
      box.appendChild(selAll);

      list.forEach(function (pr) {
        var row = document.createElement('div');
        row.className = 'tag-manager__row';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'review-item__tag-checkbox';
        cb.dataset.id = pr.id;
        var info = document.createElement('span');
        var perf = pr.perf_title ? ' · 关联:' + Auth.esc(pr.perf_title) + (pr.perf_city ? '(' + Auth.esc(pr.perf_city) + ')' : '') : '';
        var singerTag = (pr.category_name === '歌曲' && pr.singer_name) ? ' · 歌手:' + Auth.esc(pr.singer_name) : '';
        info.textContent = '「' + pr.name + '」 → ' + pr.category_name + (pr.category_status === 'pending' ? '(新类别)' : '') + singerTag + perf;
        row.appendChild(cb); row.appendChild(info);
        box.appendChild(row);
      });

      var actions = document.createElement('div');
      actions.className = 'tag-manager__row';
      var approveBtn = document.createElement('button');
      approveBtn.type = 'button'; approveBtn.className = 'btn btn--sm'; approveBtn.textContent = '批量通过';
      approveBtn.addEventListener('click', function () { batchProposals('approve'); });
      var rejectBtn = document.createElement('button');
      rejectBtn.type = 'button'; rejectBtn.className = 'btn btn--ghost btn--sm'; rejectBtn.textContent = '批量拒绝';
      rejectBtn.addEventListener('click', function () { batchProposals('reject'); });
      actions.appendChild(approveBtn); actions.appendChild(rejectBtn);
      box.appendChild(actions);

      allCb.addEventListener('change', function () {
        Array.prototype.forEach.call(box.querySelectorAll('.review-item__tag-checkbox'), function (c) { c.checked = allCb.checked; });
      });

      function batchProposals(op) {
        var ids = Array.prototype.filter.call(
          box.querySelectorAll('.review-item__tag-checkbox:checked'),
          function (c) { return c.dataset.id; }
        ).map(function (c) { return c.dataset.id; });
        if (!ids.length) { alert('请先勾选提案'); return; }
        Auth.request('PATCH', '/api/tags', { action: 'batch', ids: ids, op: op }).then(function (r) {
          if (r.ok) reload(); else alert(r.data.error || '操作失败');
        });
      }
    }).catch(function () {
      renderError(box, '提案加载失败，请检查网络或重新登录', function () { loadProposals(); });
    });
  }

  function loadTagManager() {
    var box = document.getElementById('tag-manager');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '';
    var s1 = document.createElement('div');
    s1.className = 'tag-manager__section';
    s1.innerHTML = '<h3>创建类别</h3>' +
      '<div class="tag-manager__row"><input id="tm-new-cat" class="input" placeholder="类别名,如 名场面">' +
      '<button type="button" class="btn btn--sm" id="tm-add-cat">创建</button></div>';
    var s2 = document.createElement('div');
    s2.className = 'tag-manager__section';
    s2.innerHTML = '<h3>批量加标签</h3>' +
      '<div class="tag-manager__row"><span class="list-card__meta">选择类别</span>' +
      '<select id="tm-cat-select" class="input"></select></div>' +
      '<textarea id="tm-tag-names" class="input" rows="3" placeholder="每行一个标签名"></textarea>' +
      '<div class="tag-manager__row"><button type="button" class="btn btn--sm" id="tm-add-tags">添加标签</button></div>';
    var s3 = document.createElement('div');
    s3.className = 'tag-manager__section';
    s3.innerHTML = '<h3>其它类别与标签</h3><div id="tm-existing"></div>';
    var s4 = document.createElement('div');
    s4.className = 'tag-manager__section';
    s4.innerHTML = '<h3>待审批提案</h3>' +
      '<div class="tag-manager__row"><button type="button" class="btn btn--ghost btn--sm" id="tm-proposals-load">刷新</button></div>' +
      '<div id="tm-proposals"></div>';
    box.appendChild(s1); box.appendChild(s2); box.appendChild(s3); box.appendChild(s4);

    var catSel = document.getElementById('tm-cat-select');
    loadCatalog().then(function (cat) {
      renderOtherCategories(document.getElementById('tm-existing'), cat.categories);
      populateCatSelect(catSel, cat.categories);
    }).catch(function () {
      renderError(box, '标签目录加载失败', function () { loadTagManager(); });
    });

    document.getElementById('tm-add-cat').addEventListener('click', function () {
      var name = document.getElementById('tm-new-cat').value.trim();
      if (!name) return;
      Auth.request('POST', '/api/tags', { action: 'create_category', name: name }).then(function (r) {
        if (r.ok) reload(); else alert(r.data.error || '创建失败');
      });
    });
    document.getElementById('tm-add-tags').addEventListener('click', function () {
      var catId = catSel.value;
      var names = document.getElementById('tm-tag-names').value.split(/[\n,，]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 50);
      if (!catId || !names.length) return;
      var body = { action: 'create_tags_batch', category_id: catId, names: names };
      Auth.request('POST', '/api/tags', body).then(function (r) {
        if (r.ok) reload(); else alert(r.data.error || '添加失败');
      });
    });
    document.getElementById('tm-proposals-load').addEventListener('click', loadProposals);
    loadProposals();
  }

  /* ---------- 歌手模块(待审请求 + 已上线歌手管理) ---------- */

  /** 响应归一:接口可能返回数组或 { requests: [] } */
  function asArray(d) {
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.requests)) return d.requests;
    return [];
  }

  function intentBadge(req) {
    if (req.meta_intent === 'provide') return '<span class="status status--approved">提供信息</span>';
    if (req.meta_intent === 'want') return '<span class="status status--pending">想看现场</span>';
    return '';
  }

  /** 生成 slug(与后端 makeSlug 一致):英文名小写、空格→`-`、去非 [a-z0-9-];
   *  纯非 ASCII → 返回 ''(调用方据此要求审批者必填) */
  function slugFromNameEn(nameEn) {
    return String(nameEn || '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function closeSingerApprove() {
    if (singerApproveOverlay) {
      singerApproveOverlay.classList.remove('open');
      singerApproveOverlay.remove();
      singerApproveOverlay = null;
    }
    document.removeEventListener('keydown', onApproveKey);
  }
  function onApproveKey(ev) { if (ev.key === 'Escape') closeSingerApprove(); }

  /** 批准前确认层:预览将上线的 /singer/{slug},允许审批者改 slug。
   *  默认值 = 英文名自动生成(纯中文英文名 → '' → 提示必填);
   *  已入驻占用时实时提示(将自动 -2)。确认后 PATCH approve 携带 slug。 */
  function openSingerApprove(req) {
    if (!req) return;
    // 刷新占用表(可能刚批准过别的);加载完重刷预览(首屏自动 slug 若被占用也能提示)
    Auth.request('GET', '/api/singers?admin=1').then(function (rs) {
      approveExistingIds = {};
      var arr = Array.isArray(rs.data) ? rs.data : (rs.data && Array.isArray(rs.data.list) ? rs.data.list : []);
      arr.forEach(function (s) { approveExistingIds[s.id] = 1; });
      if (singerApproveOverlay && typeof refresh === 'function') refresh();
    }).catch(function () { /* 占用提示拿不到就忽略,后端仍会 -2 */ });

    var autoSlug = slugFromNameEn(req.name_en);
    closeSingerApprove();
    singerApproveOverlay = document.createElement('div');
    singerApproveOverlay.className = 'modal open';
    singerApproveOverlay.setAttribute('role', 'dialog');
    singerApproveOverlay.setAttribute('aria-modal', 'true');
    singerApproveOverlay.setAttribute('aria-labelledby', 'sa-title');
    singerApproveOverlay.innerHTML =
      '<div class="modal-backdrop"></div>' +
      '<div class="modal-card" style="max-width:460px">' +
        '<header class="modal-head">' +
          '<div><h2 id="sa-title">批准歌手</h2>' +
          '<p class="modal-meta">' + Auth.esc(req.name_zh || '') + (req.name_en ? ' · ' + Auth.esc(req.name_en) : '') + '</p></div>' +
          '<button type="button" class="modal-close" data-sa-close aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '</header>' +
        '<div class="modal-body">' +
          '<label class="field"><span>网址 id(上线后 URL 固定)</span>' +
            '<input class="input" id="sa-slug" maxlength="60" value="' + Auth.esc(autoSlug) + '" placeholder="' + (autoSlug ? '' : '英文名无法生成,请填写,如 stefanie') + '"></label>' +
          '<p class="form-note" id="sa-preview"></p>' +
          '<p class="form-err" id="sa-err" hidden></p>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">' +
            '<button type="button" class="btn btn--ghost" data-sa-cancel>取消</button>' +
            '<button type="button" class="btn" id="sa-confirm">确认上线</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(singerApproveOverlay);

    var slugEl = singerApproveOverlay.querySelector('#sa-slug');
    var errEl = singerApproveOverlay.querySelector('#sa-err');
    var prevEl = singerApproveOverlay.querySelector('#sa-preview');

    function slugClean() {
      // 输入即清洗:仅保留小写字母数字连字符,连写 `-` 合并、去首尾
      return slugFromNameEn(slugEl.value);
    }
    function refresh() {
      var v = slugClean();
      if (slugEl.value !== v) slugEl.value = v;
      var slug = v || autoSlug;            // 空输入回退自动生成(纯中文时 autoSlug='' → 显示占位提醒)
      prevEl.textContent = '将上线为 /singer/' + slug;
      if (slug && approveExistingIds[slug]) {
        prevEl.textContent += '  ·  已被占用,将自动存为 /singer/' + slug + '-2';
      }
      errEl.hidden = true;
    }
    function validate() {
      var slug = slugClean();
      if (!slug && !autoSlug) {
        errEl.textContent = '英文名无法生成网址 id,请在上方填写(小写字母/数字/连字符)';
        errEl.hidden = false;
        return null;
      }
      if (!slug) slug = autoSlug;
      if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
        errEl.textContent = '网址 id 只能含小写字母/数字/连字符,且以字母或数字开头';
        errEl.hidden = false;
        return null;
      }
      return slug;
    }
    slugEl.addEventListener('input', refresh);
    singerApproveOverlay.querySelector('[data-sa-close]').addEventListener('click', closeSingerApprove);
    singerApproveOverlay.querySelector('[data-sa-cancel]').addEventListener('click', closeSingerApprove);
    singerApproveOverlay.querySelector('#sa-confirm').addEventListener('click', function () {
      var slug = validate();
      if (slug === null) return;
      var body = { action: 'approve' };
      if (slug) body.slug = slug;   // 与自动生成一致也显式传,杜绝后端兜底 'singer'
      var confirmBtn = singerApproveOverlay.querySelector('#sa-confirm');
      confirmBtn.disabled = true;
      Auth.request('PATCH', '/api/singer-requests/' + encodeURIComponent(req.id), body).then(function (rr) {
        if (rr.ok) { closeSingerApprove(); load(); }
        else { confirmBtn.disabled = false; errEl.textContent = rr.data.error || '批准失败'; errEl.hidden = false; }
      });
    });
    document.addEventListener('keydown', onApproveKey);
    refresh();
    slugEl.focus();
    if (slugEl.value) slugEl.select();
  }

  function loadSingerRequests(box) {
    box.innerHTML = '<p class="empty">加载中…</p>';
    Auth.request('GET', '/api/singer-requests?status=pending').then(function (r) {
      if (!r.ok) {
        renderError(box, (r.data && r.data.error) || '加载歌手申请失败', function () { loadSingerRequests(box); });
        return;
      }
      var list = asArray(r.data);
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="empty">暂无待审请求。</p>'; return; }
      list.forEach(function (req) {
        var card = document.createElement('div');
        card.className = 'list-card';
        var who = req.requester ? Auth.esc(req.requester) : Auth.esc(req.user_id || '');
        card.innerHTML =
          '<div class="list-card__head">' + intentBadge(req) +
            ' <span class="list-card__title">' + Auth.esc(req.name_zh) + '</span>' +
            (req.name_en ? ' <span class="list-card__year">' + Auth.esc(req.name_en) + '</span>' : '') +
          '</div>' +
          (req.intro ? '<div class="list-card__meta">' + Auth.esc(req.intro) + '</div>' : '') +
          '<div class="list-card__meta">请求者:' + who + ' · ' + Auth.esc((req.created_at || '').slice(0, 10)) + '</div>' +
          '<div class="list-card__actions">' +
            '<button type="button" class="btn btn--sm" data-sr-approve="' + Auth.esc(req.id) + '">批准</button> ' +
            '<button type="button" class="btn btn--ghost btn--sm" data-sr-reject="' + Auth.esc(req.id) + '">驳回</button>' +
          '</div>';
        box.appendChild(card);

        Array.prototype.forEach.call(card.querySelectorAll('[data-sr-approve]'), function (btn) {
          btn.addEventListener('click', function () { openSingerApprove(req); });
        });
        Array.prototype.forEach.call(card.querySelectorAll('[data-sr-reject]'), function (btn) {
          btn.addEventListener('click', function () {
            var doRejectSinger = function (reason) {
              if (reason === null) return;
              Auth.request('PATCH', '/api/singer-requests/' + encodeURIComponent(req.id), { action: 'reject', reject_reason: reason || '未说明' }).then(function (rr) {
                if (rr.ok) {
                  if (window.AppDialog) AppDialog.toast('已驳回该歌手申请', { type: 'info' });
                  load();
                } else {
                  if (window.AppDialog) AppDialog.alert(rr.data.error || '驳回失败', { title: '操作失败' });
                  else alert(rr.data.error || '驳回失败');
                }
              });
            };
            if (window.AppDialog) {
              AppDialog.prompt({
                title: '驳回歌手申请',
                message: '请输入驳回原因，将反馈给申请者：',
                placeholder: '如：已收录同名歌手，或信息不全...',
                multiline: true,
                confirmText: '确认驳回',
                danger: true
              }).then(doRejectSinger);
            } else {
              doRejectSinger(prompt('驳回原因:'));
            }
          });
        });
      });
    }).catch(function () {
      renderError(box, '加载歌手申请失败，请检查网络或重新登录', function () { loadSingerRequests(box); });
    });
  }

  function isInactiveSinger(s) {
    return s.active === false || s.active === 0;
  }

  function singerStatusSwitch(s) {
    var inactive = isInactiveSinger(s);
    var g = document.createElement('div');
    g.className = 'role-switch singer-status-switch';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', '歌手状态');

    var segs = [
      { key: 'active', label: '上线', title: '当前为公开展示状态', active: !inactive },
      { key: 'inactive', label: '停用', title: '当前为已停用状态', active: inactive }
    ];

    segs.forEach(function (seg) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'role-switch__seg' + (seg.active ? ' active' : '');
      b.textContent = seg.label;
      b.dataset.status = seg.key;
      b.setAttribute('aria-pressed', seg.active ? 'true' : 'false');
      if (seg.active) {
        b.title = '当前状态: ' + seg.label;
      } else {
        b.title = '点击切换为「' + seg.label + '」';
        b.addEventListener('click', function () {
          var targetActive = seg.key === 'active' ? 1 : 0;
          var msg = targetActive === 0
            ? '确定停用歌手「' + s.name_zh + '」？\n\n停用后首页及公共导航将不再展示该歌手，但历史数据及关联演出均安全保留。'
            : '确定重新上线歌手「' + s.name_zh + '」？\n\n上线后该歌手将重新在首页及全站公开展示。';
          var doToggleStatus = function () {
            b.disabled = true;
            Auth.request('PATCH', '/api/singers/' + encodeURIComponent(s.id), { active: targetActive }).then(function (r) {
              if (r.ok) {
                if (window.AppDialog) AppDialog.toast('歌手「' + s.name_zh + '」已' + seg.label, { type: 'success' });
                load();
              } else {
                b.disabled = false;
                if (window.AppDialog) AppDialog.alert(r.data.error || '切换失败', { title: '操作失败' });
                else alert(r.data.error || '切换失败');
              }
            }).catch(function () {
              b.disabled = false;
              if (window.AppDialog) AppDialog.alert('网络错误,请重试');
              else alert('网络错误,请重试');
            });
          };
          if (window.AppDialog) {
            AppDialog.confirm({
              title: targetActive === 0 ? '停用歌手确认' : '上线歌手确认',
              message: msg,
              confirmText: '确认' + seg.label,
              danger: targetActive === 0
            }).then(function (ok) { if (ok) doToggleStatus(); });
          } else if (confirm(msg)) {
            doToggleStatus();
          }
        });
      }
      g.appendChild(b);
    });
    return g;
  }

  function renderSingerRow(box, s) {
    var row = document.createElement('div');
    row.className = 'singer-manage-row';
    row.dataset.id = s.id;

    var media;
    if (s.portrait) {
      media = document.createElement('img');
      media.className = 'singer-manage__img';
      media.src = avatarSrc(s.portrait);
      media.alt = '';
      media.addEventListener('error', function () {
        var fb = document.createElement('div');
        fb.className = 'singer-manage__img singer-manage__img--fb';
        fb.textContent = (s.name_zh || '?').slice(0, 1);
        if (media.parentNode) media.parentNode.replaceChild(fb, media);
      });
    } else {
      media = document.createElement('div');
      media.className = 'singer-manage__img singer-manage__img--fb';
      media.textContent = (s.name_zh || '?').slice(0, 1);
    }
    row.appendChild(media);

    var info = document.createElement('div');
    info.className = 'singer-manage__info';
    var name = document.createElement('div');
    name.className = 'singer-manage__name';
    name.textContent = s.name_zh + (s.name_en ? ' · ' + s.name_en : '');
    info.appendChild(name);
    var meta = document.createElement('div');
    meta.className = 'singer-manage__meta';
    meta.textContent =
      (s.performance_count != null ? s.performance_count : 0) + ' 场演出 · ' +
      (s.city_count != null ? s.city_count : 0) + ' 个城市';
    info.appendChild(meta);
    row.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'singer-manage__actions';

    actions.appendChild(singerStatusSwitch(s));

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost-icon-btn';
    editBtn.title = '编辑歌手「' + (s.name_zh || '') + '」';
    editBtn.setAttribute('aria-label', '编辑歌手');
    editBtn.innerHTML = window.Icons ? Icons.get('edit') : '编辑';
    editBtn.addEventListener('click', function () { toggleSingerEdit(row, s); });
    actions.appendChild(editBtn);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ghost-icon-btn ghost-icon-btn--danger';
    delBtn.title = '删除歌手「' + (s.name_zh || '') + '」';
    delBtn.setAttribute('aria-label', '删除歌手');
    delBtn.innerHTML = window.Icons ? Icons.get('delete') : '删除';
    delBtn.addEventListener('click', function () {
      var msg = '确定删除歌手「' + s.name_zh + '」？有关联演出时无法删除，仅可停用。';
      var doDelSinger = function () {
        Auth.request('DELETE', '/api/singers/' + encodeURIComponent(s.id)).then(function (r) {
          if (r.ok) {
            if (window.AppDialog) AppDialog.toast('歌手「' + s.name_zh + '」已删除', { type: 'info' });
            load();
          } else if (r.status === 400) {
            if (window.AppDialog) AppDialog.alert(r.data.error || '该歌手下有演出，不能删除，可先停用', { title: '无法删除' });
            else alert(r.data.error || '该歌手下有演出,不能删除,可先停用');
          } else {
            if (window.AppDialog) AppDialog.alert(r.data.error || '删除失败', { title: '操作失败' });
            else alert(r.data.error || '删除失败');
          }
        });
      };
      if (window.AppDialog) {
        AppDialog.confirm({
          title: '删除歌手确认',
          message: msg,
          confirmText: '删除歌手',
          danger: true
        }).then(function (ok) { if (ok) doDelSinger(); });
      } else if (confirm(msg)) {
        doDelSinger();
      }
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);

    var editBox = document.createElement('div');
    editBox.className = 'singer-edit-box';
    editBox.hidden = true;
    row.appendChild(editBox);

    box.appendChild(row);
  }

  function toggleSingerEdit(row, s) {
    var box = row.querySelector('.singer-edit-box');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="singer-edit-grid">' +
        '<label class="field"><span>中文名</span><input class="input se-name_zh" maxlength="30" value="' + Auth.esc(s.name_zh || '') + '"></label>' +
        '<label class="field"><span>英文名</span><input class="input se-name_en" maxlength="30" value="' + Auth.esc(s.name_en || '') + '"></label>' +
        '<label class="field"><span>大头照(URL 或上传)</span><input class="input se-portrait" maxlength="200" value="' + Auth.esc(s.portrait || '') + '"></label>' +
        '<label class="field"><span>排序</span><input class="input se-sort_order" type="number" value="' + Auth.esc(s.sort_order != null ? s.sort_order : 0) + '"></label>' +
        '<label class="field field--wide"><span>简介</span><textarea class="input se-intro" rows="2" maxlength="200">' + Auth.esc(s.intro || '') + '</textarea></label>' +
      '</div>' +
      '<div class="portrait-upload-row">' +
        '<button type="button" class="ghost-icon-btn" data-se-pick="1" title="从本地上传图片替换" aria-label="从本地上传图片替换"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>' +
        '<input type="file" accept="image/*" hidden data-se-file="1">' +
        '<span class="form-note" data-se-upstat></span>' +
      '</div>' +
      '<div class="singer-manage__actions">' +
        '<button type="button" class="btn btn--sm" data-se-save="1">保存</button> ' +
        '<button type="button" class="btn btn--ghost btn--sm" data-se-cancel="1">取消</button>' +
      '</div>';
    box.querySelector('[data-se-save]').addEventListener('click', function () {
      var body = {
        action: 'update',
        name_zh: box.querySelector('.se-name_zh').value.trim(),
        name_en: box.querySelector('.se-name_en').value.trim(),
        portrait: box.querySelector('.se-portrait').value.trim(),
        intro: box.querySelector('.se-intro').value.trim(),
        sort_order: Number(box.querySelector('.se-sort_order').value)
      };
      if (!body.name_zh) { alert('中文名必填'); return; }
      if (!body.name_en) { alert('英文名必填'); return; }
      if (body.portrait && !/^https?:\/\//i.test(body.portrait) && !/^\/(?!\/)/.test(body.portrait)) {
        alert('大头照需为 http(s):// 链接或站内路径'); return;
      }
      Auth.request('PATCH', '/api/singers/' + encodeURIComponent(s.id), body).then(function (r) {
        if (r.ok) load(); else alert(r.data.error || '保存失败');
      });
    });
    box.querySelector('[data-se-cancel]').addEventListener('click', function () { box.hidden = true; });

    // 大头照本地上传替换:上传成功回填 URL 输入(与手填 URL/站内路径同路,保存时统一提交)
    var seFile = box.querySelector('[data-se-file]');
    var seUpstat = box.querySelector('[data-se-upstat]');
    box.querySelector('[data-se-pick]').addEventListener('click', function () { seFile.click(); });
    seFile.addEventListener('change', function () {
      var f = seFile.files && seFile.files[0];
      seFile.value = ''; // 允许重复选同一文件
      if (!f) return;
      seUpstat.textContent = '处理中…';
      PortraitUpload.toDataUrl(f).then(function (r) {
        return PortraitUpload.upload(r.data, r.mime).then(function (url) { return { r: r, url: url }; });
      }).then(function (res) {
        box.querySelector('.se-portrait').value = res.url;
        seUpstat.textContent = '已填入上传图,点「保存」后生效。';
        seUpstat.style.color = '';
      }).catch(function (err) {
        seUpstat.textContent = (err && err.message) ? err.message : '上传失败,请重试';
        seUpstat.style.color = '#a8372d';
      });
    });
  }

  function loadSingersManager(box) {
    box.innerHTML = '<p class="empty">加载中…</p>';
    // admin=1:review 页看全量(含停用),可重新启用;公开接口只返回 active
    Auth.request('GET', '/api/singers?admin=1').then(function (r) {
      if (!r.ok) {
        renderError(box, (r.data && r.data.error) || '加载歌手失败', function () { loadSingersManager(box); });
        return;
      }
      var list = Array.isArray(r.data) ? r.data : [];
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="empty">暂无已上线歌手。</p>'; return; }
      list.forEach(function (s) { renderSingerRow(box, s); });
    }).catch(function () {
      renderError(box, '加载歌手列表失败，请检查网络或重新登录', function () { loadSingersManager(box); });
    });
  }

  function loadSingerManager() {
    var box = document.getElementById('singer-manager');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '';
    var s1 = document.createElement('div');
    s1.className = 'tag-manager__section';
    s1.innerHTML = '<h3>待审歌手请求</h3><div id="sr-requests"></div>';
    var s2 = document.createElement('div');
    s2.className = 'tag-manager__section';
    s2.innerHTML = '<h3>已上线歌手</h3><div id="sr-singers"></div>';
    box.appendChild(s1); box.appendChild(s2);
    loadSingerRequests(document.getElementById('sr-requests'));
    loadSingersManager(document.getElementById('sr-singers'));
  }

  /* ---------- 统计看板(纯 CSS:数据总览行 / 表格 / CSS 条形) ---------- */

  function statsEmpty() { return '<p class="empty">暂无数据。</p>'; }

  function statsTable(headers, rows) {
    if (!rows.length) return statsEmpty();
    var head = '<tr>' + headers.map(function (h) { return '<th>' + Auth.esc(h) + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + Auth.esc(c == null ? '' : c) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="stats-table-wrap"><table class="stats-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function statsBars(items, max) {
    if (!items.length) return statsEmpty();
    return '<div class="stats-bars">' + items.map(function (it) {
      var pct = max > 0 ? Math.round(it.count / max * 100) : 0;
      return '<div class="stats-bar-row">' +
        '<span class="stats-bar__name">' + Auth.esc(it.name) + '</span>' +
        '<span class="stats-bar__track"><span class="stats-bar__fill" style="width:' + pct + '%"></span></span>' +
        '<span class="stats-bar__count">' + Auth.esc(it.count) + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function statsSection(title) {
    var el = document.createElement('div');
    el.className = 'stats-section';
    var h = document.createElement('h3');
    h.className = 'stats-section__title';
    h.textContent = title;
    el.appendChild(h);
    var body = document.createElement('div');
    body.className = 'stats-section__body';
    el.appendChild(body);
    return { el: el, body: body };
  }

  function appendSection(grid, title, html) {
    var sec = statsSection(title);
    sec.body.innerHTML = html;
    grid.appendChild(sec.el);
  }

  function renderTotals(box, t) {
    t = t || {};
    box.insertAdjacentHTML('beforeend', statsLedger([
      { label: '提交总数', value: t.total },
      { label: '已通过', value: t.approved },
      { label: '待审核', value: t.pending },
      { label: '已驳回', value: t.rejected },
      { label: '注册用户', value: t.users },
      { label: '歌手', value: t.singers }
    ]));
  }

  function renderSingerRequests(sr) {
    sr = sr || {};
    var rows = [
      ['状态 · 待审', sr.pending || 0],
      ['状态 · 已通过', sr.approved || 0],
      ['状态 · 已驳回', sr.rejected || 0],
      ['意向 · 提供信息', sr.provide || 0],
      ['意向 · 想看现场', sr.want || 0]
    ];
    return statsTable(['项目', '数量'], rows);
  }

  function byYearDesc(a, b) { return (b.year || 0) - (a.year || 0); }
  function byCountDesc(a, b) { return (b.count || 0) - (a.count || 0); }
  function maxCount(list) {
    if (!list.length) return 0;
    return Math.max.apply(null, list.map(function (x) { return x.count || 0; }));
  }

  function renderStats(box, d) {
    box.innerHTML = '';
    renderTotals(box, d.totals);
    var grid = document.createElement('div');
    grid.className = 'stats-sections';
    box.appendChild(grid);

    // 提交分布 · 按歌手(全部非删:通过/待审/总数)
    appendSection(grid, '提交分布 · 按歌手', statsTable(
      ['歌手', '通过', '待审', '总数'],
      (d.by_singer || []).map(function (s) {
        return [s.name_zh || s.id || '', s.approved || 0, s.pending || 0, s.total || 0];
      })
    ));

    // 提交分布 · 按年份(approved,年份降序)
    var years = (d.by_year || []).slice().sort(byYearDesc);
    appendSection(grid, '提交分布 · 按年份', statsBars(
      years.map(function (y) { return { name: String(y.year), count: y.count || 0 }; }),
      maxCount(years)
    ));

    // 提交分布 · 按城市(approved,Top 10,count 降序)
    var cities = (d.by_city || []).slice().sort(byCountDesc).slice(0, 10);
    appendSection(grid, '提交分布 · 按城市', statsBars(
      cities.map(function (c) { return { name: c.city || '(未知)', count: c.count || 0 }; }),
      maxCount(cities)
    ));

    // 提交分布 · 按类型(approved,count 降序)
    var types = (d.by_type || []).slice().sort(byCountDesc);
    appendSection(grid, '提交分布 · 按类型', statsBars(
      types.map(function (t) { return { name: t.type || '(未知)', count: t.count || 0 }; }),
      maxCount(types)
    ));

    // 提交时间线(近 30 天,按 created_at)
    appendSection(grid, '提交时间线(近 30 天)', statsTable(
      ['日期', '通过', '待审', '驳回'],
      (d.timeline || []).map(function (x) { return [x.date, x.approved || 0, x.pending || 0, x.rejected || 0]; })
    ));

    // 审核吞吐(近 30 天,按 reviewed_at)
    appendSection(grid, '审核吞吐(近 30 天)', statsTable(
      ['日期', '通过', '驳回'],
      (d.review_flow || []).map(function (x) { return [x.date, x.approved || 0, x.rejected || 0]; })
    ));

    // (Top 贡献者 / 用户注册趋势 与用户相关,已移入「访问分析」tab)

    // 标签使用排行
    appendSection(grid, '标签使用排行', statsTable(
      ['标签', '类别', '计数'],
      (d.top_tags || []).map(function (t) { return [t.name || '', t.category || '', t.count || 0]; })
    ));

    // 歌手申请统计
    appendSection(grid, '歌手申请统计', renderSingerRequests(d.singer_requests));
  }

  function loadStats() {
    var box = document.getElementById('stats-panel');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<p class="empty">加载中…</p>';
    Auth.request('GET', '/api/stats').then(function (r) {
      if (!r.ok) {
        renderError(box, (r.data && r.data.error) || '统计数据加载失败', function () { loadStats(); });
        return;
      }
      renderStats(box, r.data || {});
    }).catch(function () {
      renderError(box, '统计数据加载失败，请检查网络或重新登录', function () { loadStats(); });
    });
  }

  /* ---------- 访问分析(读取走 /api/witness?action=stats;对外路径避开 "pageview" 字样,
     否则浏览器广告/跟踪拦截器会 ERR_BLOCKED_BY_CLIENT 拦掉同源请求 —— 2026-09-03 事故) ---------- */
  function labelRange(r) {
    return { '7d': '近7天', '30d': '近30天', '90d': '近90天', 'all': '全部' }[r] || r;
  }
  /* 数据总览行(ledger):统计 tab 与访问分析 tab 共用的一套类名。
     形式为「小号从属标签 + 正文墨色数字」的通栏概览条,不是英雄数字卡片。 */
  function statsLedger(items) {
    return '<div class="stats-ledger">' + items.map(function (c) {
      return '<div class="stats-ledger__item">' +
        '<span class="stats-ledger__label">' + Auth.esc(c.label) + '</span>' +
        '<span class="stats-ledger__value">' + Auth.esc(c.value == null ? 0 : c.value) + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function loadAnalytics() {
    var box = document.getElementById('analytics-panel');
    if (!box) return;
    box.hidden = false;
    var body = document.getElementById('analytics-body');
    if (!body) return;
    body.innerHTML = '<p class="empty">加载中…</p>';
    var range = (document.getElementById('analytics-range') || {}).value || '30d';
    Auth.request('GET', '/api/witness?action=stats&range=' + encodeURIComponent(range)).then(function (r) {
      if (!r.ok) {
        renderError(body, (r.data && r.data.error) || '分析数据加载失败', function () { loadAnalytics(); });
        return;
      }
      renderAnalytics(body, r.data || {});
    }).catch(function () {
      renderError(body, '分析数据加载失败，请检查网络或重新登录', function () { loadAnalytics(); });
    });
  }

  /* ---------- 访问分析 · 图表化(2026-09-15)----------
     图元由 charts.js 画,本文件只负责**业务口径**:补零日轴、日均分母、占比合并、口径标注。
     数据契约见 .trellis/spec/backend/analytics.md;设计取舍见该任务的 design.md。 */

  var ANALYTICS_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

  /** UTC 日期加减。daily_views 的日期键来自 SQLite 的 date(created_at),那是 **UTC** 口径
   *  (created_at 为 datetime('now'))。补零轴必须用 UTC 推算 —— 若按本地时区生成,
   *  东八区下"今天"会错位一天,最后一根柱子永远是错的。 */
  function utcShift(day, delta) {
    var p = String(day).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + delta * 86400000).toISOString().slice(0, 10);
  }
  function utcToday() { return new Date().toISOString().slice(0, 10); }

  /** 接口只返回**有访问的日期**(GROUP BY,无补零),这里补成完整日轴。
   *  不补零的话,柱状图上「那天没人来」和「那天不存在」长得一模一样。 */
  function dailyAxis(range, daily) {
    var byDate = {};
    (daily || []).forEach(function (x) { if (x && x.date) byDate[x.date] = Number(x.count) || 0; });
    var today = utcToday();
    var days = ANALYTICS_RANGE_DAYS[range];
    var start;
    if (days) start = utcShift(today, -(days - 1));
    else {
      var keys = Object.keys(byDate).sort();
      if (!keys.length) return [];   // 全部范围且无任何记录 → 空态(不生成轴)
      start = keys[0];
    }
    var out = [], cur = start;
    // 上限兜底:日期异常时不至于转不出循环
    for (var i = 0; i < 4000 && cur <= today; i++) {
      out.push({ date: cur, count: byDate[cur] || 0 });
      cur = utcShift(cur, 1);
    }
    return out;
  }

  /** 日均:分母是**范围天数**,不是"有访问的天数" —— 后者会把稀疏访问算成虚高。
   *  返回 null 表示算不出(无数据),由调用方显示「—」而不是 0:
   *  0 会被读成"这段时间一个人都没来",而真相往往是"这段时间还没有数据"。 */
  function avgPerDay(range, total, axis) {
    var days = ANALYTICS_RANGE_DAYS[range];
    if (!days) {
      if (!axis.length) return null;
      days = Math.round((Date.parse(axis[axis.length - 1].date + 'T00:00:00Z') -
                         Date.parse(axis[0].date + 'T00:00:00Z')) / 86400000) + 1;
    }
    if (!days) return null;
    return Math.round((Number(total) || 0) / days * 10) / 10;
  }

  /** 页面占比:Top 3 + 余量合并。扇区上限 4 是**色阶约束**(design.md §4.3:
   *  单一色相顺序色阶要四档都过 3:1 对比度,再浅就过不了),不是为了省事。
   *  余量 = 访问总数 − Top10 之和(top_pages 是 LIMIT 10),即"榜外 + 未进榜"的页面;
   *  Top 10 的完整清单仍在下面的折叠数据表里,信息不丢。 */
  function pageSlices(pages, total) {
    var list = (pages || []).slice().sort(byCountDesc);
    var sum = list.reduce(function (a, b) { return a + (Number(b.count) || 0); }, 0);
    var rest = Math.max(0, (Number(total) || 0) - sum);
    var out = list.slice(0, 3).map(function (p) { return { label: p.page || '/', value: Number(p.count) || 0 }; });
    if (rest > 0) out.push({ label: '其余页面', value: rest });
    return out;
  }

  /** 图例 = 扇区的"直接标注"。压在扇区上的文字对比度会随色阶漂移(四档做不到都 ≥4.5:1),
   *  所以标注放环外,色块与扇区共用 .chart-ramp-N 的同一份色阶定义。 */
  function legendHtml(slices) {
    var sum = slices.reduce(function (a, b) { return a + (Number(b.value) || 0); }, 0) || 1;
    return '<ul class="chart-legend">' + slices.map(function (s, i) {
      return '<li class="chart-legend__item">' +
        '<span class="chart-legend__swatch chart-ramp-' + (i + 1) + '"></span>' +
        '<span class="chart-legend__label">' + Auth.esc(s.label) + '</span>' +
        '<span class="chart-legend__value">' + Auth.esc(s.value) + ' · ' +
          Math.round((Number(s.value) || 0) / sum * 100) + '%</span>' +
      '</li>';
    }).join('') + '</ul>';
  }

  /** 折叠数据表:图表的等价文本替代(精确数值 + 色觉障碍读者) */
  function chartDetails(headers, rows) {
    return '<details class="chart-data"><summary>数据表</summary>' + statsTable(headers, rows) + '</details>';
  }

  /** 建一个区块挂进 12 列栅格。mod 决定跨几列(宽度错落,见 style.css .analytics-grid) */
  function analyticsSection(grid, title, mod) {
    var sec = statsSection(title);
    if (mod) sec.el.classList.add(mod);
    grid.appendChild(sec.el);
    return sec.body;
  }

  function renderAnalytics(body, d) {
    body.innerHTML = '';
    if (!window.Charts) {   // charts.js 没加载成功时给一句人话,别让整块静默空白
      body.innerHTML = '<p class="empty">图表组件未加载,请刷新页面重试。</p>';
      return;
    }
    var axis = dailyAxis(d.range, d.daily_views);
    var avg = avgPerDay(d.range, d.total_views, axis);

    body.insertAdjacentHTML('beforeend', statsLedger([
      { label: '访问总数(' + labelRange(d.range) + ')', value: d.total_views },
      { label: '今日访问', value: d.today_views },
      { label: '活跃用户(有访问)', value: d.active_users },
      { label: '日均访问', value: avg == null ? '—' : avg }
    ]));

    var grid = document.createElement('div');
    grid.className = 'analytics-grid';
    body.appendChild(grid);

    // ① 每日访问量 · 柱状图(通栏主图)。用柱不用折线:访问量是稀疏小整数,
    //    折线会把 0 值日期插值出假趋势,柱状里"零"是看得见的。
    var dailyBody = analyticsSection(grid, '每日访问量 · ' + labelRange(d.range));
    if (axis.length) {
      var dailyHost = document.createElement('div');
      dailyBody.appendChild(dailyHost);
      Charts.columns(dailyHost, {
        points: axis.map(function (x) {
          return { label: x.date.slice(5), value: x.count, title: x.date + ':' + x.count + ' 次' };
        }),
        unit: '次',
        ariaLabel: '每日访问量柱状图:' + axis[0].date + ' 至 ' + axis[axis.length - 1].date +
          ' 共 ' + axis.length + ' 天,合计 ' + (Number(d.total_views) || 0) + ' 次,单日最高 ' +
          maxCount(axis) + ' 次'
      });
      dailyBody.insertAdjacentHTML('beforeend', chartDetails(['日期', '访问量'],
        axis.map(function (x) { return [x.date, x.count]; })));
    } else {
      dailyBody.innerHTML = statsEmpty();
    }

    // ② 页面访问占比 · 环形图  ‖  ③ 用户访问榜 · 排名横条(并排 5:7)
    var pages = (d.top_pages || []).slice().sort(byCountDesc);
    var slices = pageSlices(pages, d.total_views);
    var pieBody = analyticsSection(grid, '页面访问占比 · ' + labelRange(d.range), 'stats-section--narrow');
    if (slices.length) {
      var pieHost = document.createElement('div');
      pieBody.appendChild(pieHost);
      Charts.donut(pieHost, {
        slices: slices,
        unit: '次',
        center: Number(d.total_views) || 0,
        ariaLabel: '页面访问占比环形图,共 ' + slices.length + ' 项,合计 ' + (Number(d.total_views) || 0) + ' 次'
      });
      pieBody.insertAdjacentHTML('beforeend', legendHtml(slices));
      pieBody.insertAdjacentHTML('beforeend', chartDetails(['页面', '访问量'],
        pages.map(function (p) { return [p.page || '/', Number(p.count) || 0]; })));
    } else {
      pieBody.innerHTML = statsEmpty();
    }

    var visitors = (d.visitors || []).slice(0, 8);
    var rankBody = analyticsSection(grid, '用户访问榜 · ' + labelRange(d.range), 'stats-section--wide');
    if (visitors.length) {
      var rankHost = document.createElement('div');
      rankBody.appendChild(rankHost);
      Charts.rankBars(rankHost, {
        rows: visitors.map(function (v) {
          return {
            label: v.name || '(已注销)',
            value: Number(v.visits) || 0,
            meta: '最近 ' + (fmtAuditTime(v.last_visit) || '—')
          };
        }),
        unit: '次',
        ariaLabel: '用户访问榜排名条形图,共 ' + visitors.length + ' 位注册用户'
      });
      rankBody.insertAdjacentHTML('beforeend', chartDetails(['用户', '访问次数', '最近访问', '首次访问'],
        (d.visitors || []).map(function (v) {
          return [v.name || '(已注销)', Number(v.visits) || 0, fmtAuditTime(v.last_visit), fmtAuditTime(v.first_visit)];
        })));
    } else {
      rankBody.innerHTML = statsEmpty();
    }

    // ④ 提交贡献 · 堆叠横条。⚠ 该接口**不随 range**(全部时间,SQL 里没有范围谓词),
    //    标题必须点明,否则会被读成"跟着上面的范围走"。
    var contrib = d.top_contributors || [];
    var contribBody = analyticsSection(grid, '提交贡献 · 全部时间(不随范围变化)');
    if (contrib.length) {
      var contribHost = document.createElement('div');
      contribBody.appendChild(contribHost);
      Charts.stackedBars(contribHost, {
        rows: contrib.map(function (c) {
          return {
            label: c.name || '(未知)',
            parts: [
              { value: Number(c.approved) || 0, tone: 'approved' },
              { value: Number(c.pending) || 0, tone: 'pending' }
            ]
          };
        }),
        unit: '条',
        ariaLabel: '提交贡献堆叠条形图(通过 / 待审),全部时间口径'
      });
      contribBody.insertAdjacentHTML('beforeend', chartDetails(['用户', '通过', '待审', '总数'],
        contrib.map(function (c) {
          return [c.name || '(未知)', Number(c.approved) || 0, Number(c.pending) || 0, Number(c.total) || 0];
        })));
    } else {
      contribBody.innerHTML = statsEmpty();
    }

    // ⑤ 最近访问明细:日志型数据,表格才是对的形态(不图表化)。
    //    同样**不随 range**(固定最近 20 条),标题一并点明。
    analyticsSection(grid, '最近访问 · 最近 20 条(不随范围变化)').innerHTML = statsTable(
      ['时间', '页面', '用户'],
      (d.recent || []).map(function (r) { return [fmtAuditTime(r.created_at), r.page || '/', r.name || '匿名']; })
    );
  }

  /** 加载与审核微简介 (众包一句话简介) */
  function loadIntros(status, singer, box) {
    box.innerHTML = '<p class="empty">加载中…</p>';
    var url = '/api/singer-intros?admin=1&status=' + encodeURIComponent(status);
    if (singer) url += '&singer=' + encodeURIComponent(singer);
    Auth.request('GET', url).then(function (r) {
      if (!r.ok || !r.data || !r.data.intros) {
        renderError(box, (r.data && r.data.error) || '微简介加载失败', function () {
          loadIntros(status, singer, box);
        });
        return;
      }
      var list = r.data.intros;
      if (!list.length) {
        box.innerHTML = '<p class="empty">暂无该状态下的微简介。</p>';
        return;
      }
      box.innerHTML = '';
      list.forEach(function (it) {
        var card = document.createElement('div');
        card.className = 'list-card';
        var head =
          '<div class="list-card__head">' +
            '<span class="badge type">' + Auth.esc(it.singer_name || it.singer_id) + '</span> ' +
            '<span class="list-card__submitter">by @' + Auth.esc(it.submitter_username || it.submitter_name) + '</span>' +
            '<span class="list-card__year" style="margin-left:auto;">' + Auth.esc(it.created_at || '') + '</span>' +
          '</div>';
        var body = '<div class="list-card__title" style="margin: 10px 0 4px; font-size: var(--fs-lg);">“' + Auth.esc(it.content) + '”</div>';
        var reject = it.reject_reason ? '<div class="list-card__reject">驳回原因: ' + Auth.esc(it.reject_reason) + '</div>' : '';

        var actions = '<div class="list-card__actions">';
        if (status === 'pending') {
          actions += '<button type="button" class="btn btn--sm" data-act="approve-intro" data-id="' + Auth.esc(it.id) + '">通过</button> ' +
            '<button type="button" class="btn btn--ghost btn--sm" data-act="reject-intro" data-id="' + Auth.esc(it.id) + '">驳回</button> ' +
            '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="del-intro" data-id="' + Auth.esc(it.id) + '" title="移入回收站" aria-label="移入回收站">' +
              (window.Icons ? Icons.get('delete') : '删除') +
            '</button>';
        } else if (status === 'approved') {
          actions += '<button type="button" class="btn btn--ghost btn--sm" data-act="reject-intro" data-id="' + Auth.esc(it.id) + '">驳回</button> ' +
            '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="del-intro" data-id="' + Auth.esc(it.id) + '" title="移入回收站" aria-label="移入回收站">' +
              (window.Icons ? Icons.get('delete') : '删除') +
            '</button>';
        } else if (status === 'rejected') {
          actions += '<button type="button" class="btn btn--sm" data-act="approve-intro" data-id="' + Auth.esc(it.id) + '">重新通过</button> ' +
            '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="del-intro" data-id="' + Auth.esc(it.id) + '" title="移入回收站" aria-label="移入回收站">' +
              (window.Icons ? Icons.get('delete') : '删除') +
            '</button>';
        } else if (status === 'trash') {
          actions += '<button type="button" class="ghost-icon-btn" data-act="restore-intro" data-id="' + Auth.esc(it.id) + '" title="恢复" aria-label="恢复">' +
              (window.Icons ? Icons.get('restore') : '恢复') +
            '</button> ' +
            '<button type="button" class="ghost-icon-btn ghost-icon-btn--danger" data-act="purge-intro" data-id="' + Auth.esc(it.id) + '" title="彻底删除" aria-label="彻底删除">' +
              (window.Icons ? Icons.get('delete') : '彻底删除') +
            '</button>';
        }
        actions += '</div>';

        card.innerHTML = head + body + reject + actions;
        box.appendChild(card);
      });

      // 绑定操作按键
      Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (btn) {
        btn.addEventListener('click', function () {
          var act = btn.getAttribute('data-act');
          var id = btn.getAttribute('data-id');
          if (act === 'approve-intro') {
            Auth.request('PATCH', '/api/singer-intros/' + encodeURIComponent(id), { action: 'approve' })
              .then(function (res) {
                if (res.ok) {
                  if (window.AppDialog && AppDialog.toast) AppDialog.toast('已审核通过并入库', { type: 'success' });
                  loadIntros(status, singer, box);
                } else {
                  if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '操作失败', { title: '操作失败' });
                }
              });
          } else if (act === 'reject-intro') {
            var doReject = function (reason) {
              if (reason === null) return;
              Auth.request('PATCH', '/api/singer-intros/' + encodeURIComponent(id), { action: 'reject', reject_reason: reason })
                .then(function (res) {
                  if (res.ok) {
                    if (window.AppDialog && AppDialog.toast) AppDialog.toast('已驳回该条微简介', { type: 'info' });
                    loadIntros(status, singer, box);
                  } else {
                    if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '操作失败', { title: '操作失败' });
                  }
                });
            };
            if (window.AppDialog && AppDialog.prompt) {
              AppDialog.prompt({
                title: '驳回微简介',
                message: '请输入驳回原因，将反馈给提交用户：',
                placeholder: '如：含有不当言论或与歌手明显无关...',
                confirmText: '确认驳回',
                danger: true
              }).then(doReject);
            } else {
              doReject(prompt('驳回原因:'));
            }
          } else if (act === 'del-intro') {
            var doDel = function () {
              Auth.request('DELETE', '/api/singer-intros/' + encodeURIComponent(id))
                .then(function (res) {
                  if (res.ok) {
                    if (window.AppDialog && AppDialog.toast) AppDialog.toast('已移入回收站', { type: 'info' });
                    loadIntros(status, singer, box);
                  } else {
                    if (window.AppDialog) AppDialog.alert((res.data && res.data.error) || '操作失败', { title: '操作失败' });
                  }
                });
            };
            if (window.AppDialog && AppDialog.confirm) {
              AppDialog.confirm({
                title: '移入回收站',
                message: '确定将该条微简介移入回收站吗？',
                confirmText: '移入回收站',
                danger: true
              }).then(function (ok) { if (ok) doDel(); });
            } else if (confirm('移入回收站？')) {
              doDel();
            }
          } else if (act === 'restore-intro') {
            Auth.request('PATCH', '/api/singer-intros/' + encodeURIComponent(id), { action: 'approve' })
              .then(function (res) {
                if (res.ok) {
                  if (window.AppDialog && AppDialog.toast) AppDialog.toast('已恢复为已通过状态', { type: 'success' });
                  loadIntros(status, singer, box);
                }
              });
          } else if (act === 'purge-intro') {
            var doPurge = function () {
              Auth.request('DELETE', '/api/singer-intros/' + encodeURIComponent(id))
                .then(function (res) {
                  if (res.ok) {
                    if (window.AppDialog && AppDialog.toast) AppDialog.toast('已彻底删除', { type: 'info' });
                    loadIntros(status, singer, box);
                  }
                });
            };
            if (window.AppDialog && AppDialog.confirm) {
              AppDialog.confirm({
                title: '彻底删除',
                message: '确定彻底删除该微简介吗？操作不可恢复。',
                confirmText: '彻底删除',
                danger: true
              }).then(function (ok) { if (ok) doPurge(); });
            } else if (confirm('彻底删除？')) {
              doPurge();
            }
          }
        });
      });
    }).catch(function () {
      renderError(box, '微简介加载失败，请检查网络或重新登录', function () {
        loadIntros(status, singer, box);
      });
    });
  }

  function load() {
    resetBatchUI();
    var listBox = document.getElementById('review-list');
    var tagBox = document.getElementById('tag-manager');
    var songBox = document.getElementById('song-manager');
    var singerBox = document.getElementById('singer-manager');
    var statsBox = document.getElementById('stats-panel');
    var auditBox = document.getElementById('audit-box');
    var analyticsBox = document.getElementById('analytics-panel');
    if (!listBox || !tagBox) return;
    // 「演出提交」与「微简介」栏目条(状态分段 + 歌手筛选)
    var subbar = document.getElementById('review-subbar');
    if (subbar) subbar.hidden = (current !== 'submissions' && current !== 'intros');
    if (current === 'submissions' || current === 'intros') ensureSingerFilter();
    if (songBox) songBox.hidden = true;
    if (singerBox) singerBox.hidden = true;
    if (statsBox) statsBox.hidden = true;
    if (auditBox) auditBox.hidden = true;
    if (analyticsBox) analyticsBox.hidden = true;
    if (current === 'intros') {
      tagBox.hidden = true; listBox.hidden = false;
      loadIntros(statusSel, statusSinger, listBox);
      return;
    }
    if (current === 'users') {
      tagBox.hidden = true; listBox.hidden = false;
      listBox.innerHTML = '<p class="empty">加载中…</p>';
      loadUsers(listBox);
      return;
    }
    if (current === 'tags') {
      listBox.hidden = true;
      if (songBox) songBox.hidden = true;
      loadTagManager();
      return;
    }
    if (current === 'songs') {
      tagBox.hidden = true; listBox.hidden = true;
      if (songBox) songBox.hidden = false;
      loadSongManager();
      return;
    }
    if (current === 'singers') {
      tagBox.hidden = true; listBox.hidden = true;
      loadSingerManager();
      return;
    }
    if (current === 'stats') {
      tagBox.hidden = true; listBox.hidden = true;
      loadStats();
      return;
    }
    if (current === 'analytics') {
      tagBox.hidden = true; listBox.hidden = true;
      loadAnalytics();
      return;
    }
    if (current === 'audit') {
      tagBox.hidden = true; listBox.hidden = true;
      loadAudit(auditBox);
      return;
    }
    tagBox.hidden = true; listBox.hidden = false;
    loadList(statusSel, listBox);
  }

  document.addEventListener('DOMContentLoaded', function () {
    Auth.renderAuthLink(document.getElementById('auth-link'));
    // 输密码期间就开始拉数据(geoguide 模式):不等解锁,先 fire 预加载
    preloadNow();

    Auth.me().then(function (u) {
      if (u && u.role === 'admin') me = u;
      var gate = document.getElementById('admin-gate');
      if (!u || u.role !== 'admin') {
        gate.innerHTML = '<p class="empty">需要管理员权限。</p>';
        return;
      }
      if (!u.admin_auth) {
        // 审核密码门:输入 ADMIN_PASSWORD 解锁(12 小时内有效)
        gate.innerHTML =
          '<form class="auth-box" id="admin-pw-form">' +
            '<h3 class="auth-title">审核密码</h3>' +
            '<p class="auth-hint">进入审核需要管理员密码;本浏览器会话内解锁,关闭浏览器后需重新输入。</p>' +
            '<label class="field"><span>密码</span><input id="admin-pw" type="password" class="input" autocomplete="current-password" autofocus></label>' +
            '<div class="auth-actions"><button type="submit" class="btn" id="admin-pw-btn">解锁</button></div>' +
            '<p id="admin-pw-msg" class="auth-err" hidden></p>' +
          '</form>';
        var pwInput = document.getElementById('admin-pw');
        var pwBtn = document.getElementById('admin-pw-btn');
        var pwMsg = document.getElementById('admin-pw-msg');
        var pwForm = document.getElementById('admin-pw-form');

        var doUnlock = function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          var pw = pwInput.value;
          if (!pw) {
            pwMsg.textContent = '请输入审核密码';
            pwMsg.hidden = false;
            pwInput.focus();
            return;
          }
          pwBtn.disabled = true;
          Auth.request('POST', '/api/auth/admin-auth', { password: pw }).then(function (r) {
            pwBtn.disabled = false;
            if (r.ok) {
              // 直接进入并加载,不整页 reload:预加载数据在输密码期间已就绪(或兜底即时重拉)
              gate.hidden = true;
              document.getElementById('review-box').hidden = false;
              load();
            } else {
              pwMsg.textContent = (r.data && r.data.error) || '密码错误';
              pwMsg.hidden = false;
              pwInput.focus();
              pwInput.select();
            }
          }).catch(function () {
            pwBtn.disabled = false;
            pwMsg.textContent = '网络错误，请稍后重试';
            pwMsg.hidden = false;
          });
        };

        if (pwForm) pwForm.addEventListener('submit', doUnlock);
        pwBtn.addEventListener('click', doUnlock);
        pwInput.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            doUnlock();
          }
        });
        setTimeout(function () { if (pwInput) pwInput.focus(); }, 50);
        return;
      }
      gate.hidden = true;
      document.getElementById('review-box').hidden = false;
      load();
    });

    var tabs = document.getElementById('review-tabs');
    if (tabs) tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.review-tab');
      if (!btn) return;
      current = btn.getAttribute('data-module');
      Array.prototype.forEach.call(tabs.querySelectorAll('.review-tab'), function (t) {
        t.classList.toggle('active', t === btn);
      });
      load();
    });

    // ↻ 刷新:局部重拉当前模块(清预载/目录缓存,不整页 reload——仿 geoguide disableWhile)
    var reloadBtn = document.getElementById('review-reload-btn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function () {
        reloadBtn.disabled = true;
        var oldHtml = reloadBtn.innerHTML;
        reloadBtn.textContent = '刷新中…';
        Object.keys(_preload).forEach(function (k) { delete _preload[k]; });
        tagCache = {}; _singersCache = null;
        load();
        setTimeout(function () { reloadBtn.disabled = false; reloadBtn.innerHTML = oldHtml; }, 500);
      });
    }

    /* ---------- 「演出提交」栏目:状态切换 + 歌手筛选 ---------- */
    var statusBar = document.getElementById('review-status');
    if (statusBar) {
      statusBar.addEventListener('click', function (e) {
        var b = e.target.closest('.review-status__seg');
        if (!b) return;
        if (b.getAttribute('data-status') === statusSel) return; // 点当前状态不重载
        statusSel = b.getAttribute('data-status');
        Array.prototype.forEach.call(statusBar.querySelectorAll('.review-status__seg'), function (t) {
          t.classList.toggle('active', t === b);
        });
        load();
      });
    }
    var singerSel = document.getElementById('review-singer');
    if (singerSel) {
      singerSel.addEventListener('change', function () {
        var v = singerSel.value || '';
        if (v === statusSinger) return;
        statusSinger = v;
        load();
      });
    }

    // 访问分析:范围切换 / 手动刷新
    var anRange = document.getElementById('analytics-range');
    if (anRange) anRange.addEventListener('change', function () { loadAnalytics(); });
    var anReload = document.getElementById('analytics-reload');
    if (anReload) anReload.addEventListener('click', function () { loadAnalytics(); });

    /* ---------- 批量通过 / 驳回(仅待审核列表;全选 + 底部批量条) ---------- */
    var selAllCb = document.getElementById('review-selall-cb');
    if (selAllCb) {
      selAllCb.addEventListener('change', function () {
        Array.prototype.forEach.call(
          document.querySelectorAll('#review-list .review-item__checkbox'),
          function (cb) {
            cb.checked = selAllCb.checked;
            var id = cb.getAttribute('data-id');
            if (cb.checked) batchSel[id] = true; else delete batchSel[id];
          }
        );
        syncSelAll();
        updateBatchBar();
      });
    }
    /** 分批执行(后端单次上限 50,前端切成 ≤50 一组逐串跑;单串失败不中断) */
    function runBatch(ids, op, reason) {
      var chunks = [];
      for (var i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
      var idx = 0;
      return new Promise(function (resolve) {
        (function step() {
          if (idx >= chunks.length) { resolve(); return; }
          var ids0 = chunks[idx++];
          Auth.request('PATCH', '/api/review', { action: 'batch', ids: ids0, op: op, reject_reason: reason }).then(function (r) {
            if (!r.ok) alert((r.data && r.data.error) || '批量操作失败');
            step();
          }).catch(function () { alert('网络错误,请重试'); step(); });
        })();
      });
    }
    var bApprove = document.getElementById('review-batch-approve');
    if (bApprove) {
      bApprove.addEventListener('click', function () {
        var ids = selectedBatchIds();
        if (!ids.length) return;
        var doBatchApprove = function () {
          bApprove.disabled = true;
          runBatch(ids, 'approve', '').then(function () {
            bApprove.disabled = false;
            if (window.AppDialog) AppDialog.toast('已批量通过 ' + ids.length + ' 条', { type: 'success' });
            load();
          });
        };
        if (window.AppDialog) {
          AppDialog.confirm({
            title: '批量通过',
            message: '确认通过所选 ' + ids.length + ' 条提交吗？(草稿将合并进原条目)',
            confirmText: '确认通过'
          }).then(function (ok) { if (ok) doBatchApprove(); });
        } else if (confirm('确认通过所选 ' + ids.length + ' 条?(草稿将合并进原条目)')) {
          doBatchApprove();
        }
      });
    }
    var bReject = document.getElementById('review-batch-reject');
    if (bReject) {
      bReject.addEventListener('click', function () {
        var ids = selectedBatchIds();
        if (!ids.length) return;
        var doBatchReject = function (reason) {
          if (reason === null) return;
          bReject.disabled = true;
          runBatch(ids, 'reject', reason || '未说明').then(function () {
            bReject.disabled = false;
            if (window.AppDialog) AppDialog.toast('已批量驳回 ' + ids.length + ' 条', { type: 'info' });
            load();
          });
        };
        if (window.AppDialog) {
          AppDialog.prompt({
            title: '批量驳回',
            message: '请输入驳回原因（将统一应用于所选 ' + ids.length + ' 条）：',
            placeholder: '如：视频链接已失效...',
            multiline: true,
            confirmText: '确认驳回',
            danger: true
          }).then(doBatchReject);
        } else {
          doBatchReject(prompt('驳回原因(应用于所选 ' + ids.length + ' 条):'));
        }
      });
    }
    var bClear = document.getElementById('review-batch-clear');
    if (bClear) {
      bClear.addEventListener('click', function () {
        resetBatchUI();
      });
    }
  });
})();
