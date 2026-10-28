/* profile.js —— 个人中心:档案头(头像 + 用户名 + 角色)+ 提交统计 + 我的收藏 + 修改密码/用户名/头像
 *
 * 静态骨架在 profile.html(#profile-box,Default hidden);本文件只填动态内容 + 绑事件。
 * 头像值文法 / 解析见 public/js/avatars.js;压缩上传见 public/js/portrait-upload.js。
 * F1–F8 行为(登录门 / 统计 / 收藏深链与取消 / 改密强制重登)与旧版等价,只换容器。
 */

(function () {
  'use strict';

  var user = null;

  // ---- 我的收藏:全量数据 + 全量搜索 + 客户端分页(任务 09-14;契约见 design.md §2) ----
  var favsAll = [];                 // 全量收藏 —— 搜索与分页的**唯一**数据源
  var favQuery = '';                // 已 lower + trim 的搜索词(仅用于匹配)
  var favQueryRaw = '';             // 用户输入的原文(仅用于回显):归一化只该影响匹配,不该改用户看到的东西
  var favPage = 1;
  var FAV_PAGE_SIZE = 12;           // prd D2:4 列 × 3 行
  var FAV_FIELDS = ['title', 'city', 'date', 'type', 'singer_name'];   // prd D4:所见即所搜

  /** 收藏卡深链:点标题跳到 /singer/{singer}?perf={id},歌手页按演出 id 反查城市后自动弹窗并定位到那一场。
   *  权威是 perf(演出 id),城市不在 URL 里 —— 演出被改过城市时链接自愈(见任务 09-13)。
   *  id 缺失(脏数据)→ 退化为纯歌手页链接,不产生空 ?perf=。 */
  function favHref(f) {
    var href = '/singer/' + encodeURIComponent(f.singer || '');
    return f.id ? href + '?perf=' + encodeURIComponent(f.id) : href;
  }

  /** 搜索命中:任一可见字段 lower 后含 favQuery(空词恒真) */
  function favMatches(f) {
    if (!favQuery) return true;
    for (var i = 0; i < FAV_FIELDS.length; i++) {
      var v = f[FAV_FIELDS[i]];
      if (v != null && String(v).toLowerCase().indexOf(favQuery) !== -1) return true;
    }
    return false;
  }

  /** 单张收藏卡 HTML(深链 / 卡片结构沿用 09-13,不变) */
  function favCardHtml(f) {
    var date = f.date || '';
    var bits = [f.city, date, f.singer_name].filter(Boolean).join(' · ');
    // 取消收藏 = 点亮的五角星:复用弹窗里那套 .perf-fav / .perf-fav.on 语汇(同一个星形 path、
    // 同一组 --star 令牌)。在「我的收藏」里每条都必然是已收藏,故恒为 on 态,点一下即取消。
    // .perf-fav 自带 margin-left:auto,在 .list-card__head(flex)里自动靠右。
    var star = '<button type="button" class="perf-fav on" data-act="unfav"' +
      ' aria-pressed="true" aria-label="取消收藏" title="取消收藏">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.6-6.2 3.6 1.6-7L2 9.2l7.1-.6z"/></svg>' +
      '</button>';
    var shareBtn = '<button type="button" class="ghost-icon-btn fav-share-btn" data-act="share"' +
      ' data-fav-id="' + Auth.esc(f.id) + '"' +
      ' data-singer="' + Auth.esc(f.singer || '') + '"' +
      ' aria-label="复制演出链接" title="复制演出链接">' +
      (window.Icons ? Icons.get('share') : '分享') +
      '</button>';
    return '<div class="list-card" data-fav-id="' + Auth.esc(f.id) + '">' +
      '<div class="list-card__head">' +
        '<span class="badge type" data-type="' + Auth.esc(f.type || '演出') + '">' + Auth.esc(f.type || '演出') + '</span>' +
        (f.year ? '<span class="list-card__year">' + Auth.esc(f.year) + '</span>' : '') +
        shareBtn +
        star +
      '</div>' +
      '<div class="list-card__title"><a class="fav-title" href="' + Auth.esc(favHref(f)) + '">' + Auth.esc(f.title) + '</a></div>' +
      (bits ? '<div class="list-card__meta">' + Auth.esc(bits) + '</div>' : '') +
    '</div>';
  }

  /** 唯一渲染路径(design.md §2.3):在 favsAll 上过滤 → 按页切片。
   *  页码钳位只在这一处 —— 搜索 / 翻页 / 取消收藏三个入口都收敛到这里(AC9)。 */
  function renderFavs() {
    var box = document.getElementById('fav-list');
    if (!box) return;
    var bar = document.getElementById('fav-bar');
    var countEl = document.getElementById('fav-count');
    var pager = document.getElementById('fav-pager');

    // 无收藏:既有引导文案;搜索栏与分页隐藏(不是空着占位)
    if (!favsAll.length) {
      box.innerHTML = '<p class="list-card__meta">还没有收藏,去<a href="/singer">歌手地图</a>点亮 ☆</p>';
      if (bar) bar.hidden = true;
      if (pager) pager.hidden = true;
      syncSearchClear();
      return;
    }
    if (bar) bar.hidden = false;

    var hits = favsAll.filter(favMatches);           // ← 全量搜索:在全部收藏上过滤,不是当前页
    var total = hits.length;
    var pages = Math.max(1, Math.ceil(total / FAV_PAGE_SIZE));
    favPage = Math.min(Math.max(1, favPage), pages); // ← 唯一钳位点(删空当页自动回退)

    if (!total) {
      // 有收藏但无命中:明确空态;分页隐藏,搜索栏与清除钮保留
      // 回显原文而非 favQuery:后者是 lower 过的,会把用户输的「Soul」显示成「soul」
      box.innerHTML = '<p class="list-card__meta">没有匹配「' + Auth.esc(favQueryRaw) + '」的收藏</p>';
    } else {
      var page = hits.slice((favPage - 1) * FAV_PAGE_SIZE, favPage * FAV_PAGE_SIZE);
      box.innerHTML = page.map(favCardHtml).join('');
      bindUnfav(box);
      bindShare(box);
    }

    if (countEl) countEl.textContent = favQuery ? ('找到 ' + total + ' 条') : ('共 ' + total + ' 条');

    if (pager) pager.hidden = !(pages > 1);
    var pos = document.getElementById('fav-page');
    if (pos) pos.textContent = '第 ' + favPage + ' / ' + pages + ' 页';
    var prev = document.getElementById('fav-prev');
    var next = document.getElementById('fav-next');
    if (prev) prev.disabled = favPage <= 1;
    if (next) next.disabled = favPage >= pages;

    syncSearchClear();
  }

  /** 搜索框右侧清除钮:有搜索词才出现 */
  function syncSearchClear() {
    var c = document.getElementById('fav-search-clear');
    if (c) c.hidden = !favQuery;
  }

  /** 分享演出链接 */
  function bindShare(box) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-act="share"]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var favId = btn.getAttribute('data-fav-id');
        var singer = btn.getAttribute('data-singer');
        var url = window.ShareUtils
          ? window.ShareUtils.buildPerformanceShareUrl({ id: favId, singer: singer })
          : (window.location.origin + '/singer/' + encodeURIComponent(singer || 'david-tao') + '?perf=' + encodeURIComponent(favId));
        if (window.ShareUtils) {
          window.ShareUtils.copyWithFeedback(btn, url, '演出链接已复制');
        }
      });
    });
  }

  /** 取消收藏:改数据源再重渲(W/C-2),不再只删 DOM —— 否则计数 / 页码 / 搜索结果全错 */
  function bindUnfav(box) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-act="unfav"]'), function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.list-card');
        var id = card && card.getAttribute('data-fav-id');
        if (id == null) return;
        btn.disabled = true;
        Auth.request('DELETE', '/api/favorites', { performance_id: id }).then(function (res) {
          if (!res.ok) {
            btn.disabled = false;
            if (window.AppDialog) AppDialog.alert(res.data.error || '取消失败', { title: '操作失败' });
            else alert(res.data.error || '取消失败');
            return;
          }
          favsAll = favsAll.filter(function (f) { return String(f.id) !== String(id); });
          renderFavs();
        });
      });
    });
  }

  /** 拉我的收藏(GET /api/favorites,登录;游客不会到达这里)。
   *  接口一次性返回全部 → 客户端过滤 + 分页(prd D5,不改后端)。 */
  function loadFavs() {
    fetch('/api/favorites').then(function (r) { return r.json(); }).then(function (list) {
      favsAll = Array.isArray(list) ? list : [];
      favPage = 1;
      renderFavs();
    }).catch(function () {
      var box = document.getElementById('fav-list');
      if (box) box.innerHTML = '<p class="list-card__meta">收藏加载失败,请刷新重试</p>';
    });
  }

  /** 提交统计 → 账本(四格:待审 / 通过 / 驳回 / 总计),数据源不变 */
  function renderStats(list) {
    var ledger = document.getElementById('stats-ledger');
    if (!ledger) return;
    var c = { pending: 0, approved: 0, rejected: 0 };
    (list || []).forEach(function (p) { if (c[p.status] != null) c[p.status]++; });
    var items = [
      ['待审核', c.pending], ['已通过', c.approved], ['已驳回', c.rejected],
      ['总计', c.pending + c.approved + c.rejected]
    ];
    ledger.innerHTML = items.map(function (it) {
      return '<div class="stats-ledger__item"><span class="stats-ledger__label">' + it[0] +
        '</span><span class="stats-ledger__value">' + it[1] + '</span></div>';
    }).join('');
  }

  /** 头像三态渲染:上传图(<img>)/ 内置默认(内联 SVG)/ 加载失败回退首字母块 */
  function renderAvatar() {
    var face = document.getElementById('avatar-face');
    if (!face || !user) return;
    var info = Avatars.resolve(user.avatar_url, user.id);
    face.className = 'profile-hero__face';
    if (info.kind === 'upload') {
      face.innerHTML = '';
      var img = document.createElement('img');
      img.alt = '';
      img.src = info.src;
      img.addEventListener('error', function () {
        // 上传图 404/不可达 → 首字母块,不出现破图(镜像 .masthead__avatar--fallback 惯例)
        face.className = 'profile-hero__face masthead__avatar--fallback';
        face.textContent = (user.username || '?').charAt(0).toUpperCase();
      });
      face.appendChild(img);
    } else {
      face.innerHTML = Avatars.svg(info.key);
    }
    markPicker();
  }

  /** 头像选择面板:6 个内置默认 + 本地上传 */
  function renderPicker() {
    var box = document.getElementById('avatar-picker');
    if (!box) return;
    box.innerHTML = Avatars.KEYS.map(function (k) {
      return '<button type="button" class="avatar-choice" data-key="' + k +
        '" aria-label="选择内置头像" aria-pressed="false">' + Avatars.svg(k) + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.avatar-choice'), function (btn) {
      btn.addEventListener('click', function () { chooseDefault(btn.getAttribute('data-key')); });
    });
    markPicker();
  }

  function markPicker() {
    var box = document.getElementById('avatar-picker');
    if (!box || !user) return;
    var info = Avatars.resolve(user.avatar_url, user.id);
    Array.prototype.forEach.call(box.querySelectorAll('.avatar-choice'), function (btn) {
      var on = info.kind === 'default' && btn.getAttribute('data-key') === info.key;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function showMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.className = 'profile-editor__msg' + (kind ? ' is-' + kind : '');
  }

  /** POST /api/auth/avatar;成功返回落库值,失败显示错误并返回 null */
  function saveAvatar(value, msgEl) {
    return Auth.request('POST', '/api/auth/avatar', { avatar: value }).then(function (r) {
      if (!r.ok) { showMsg(msgEl, r.data.error || '保存失败'); return null; }
      showMsg(msgEl, '头像已更新', 'ok');
      return r.data.avatar;
    });
  }

  function chooseDefault(key) {
    var msg = document.getElementById('avatar-msg');
    saveAvatar('default:' + key, msg).then(function (v) {
      if (v == null) return;
      user.avatar_url = v;
      renderAvatar();
    });
  }

  /** 头像面板(行内)开关:09-14 起它是唯一剩下的行内编辑器(账号设置已改为弹窗) */
  function setAvatarPanel(open) {
    var pnl = document.getElementById('avatar-panel');
    var btn = document.getElementById('avatar-btn');
    if (pnl) pnl.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ---- 账号设置弹窗(复用全局 .modal* 样式 + 本页开关逻辑;design.md §2.5) ----
  function isAccountOpen() {
    var m = document.getElementById('account-modal');
    return !!(m && m.classList.contains('open'));
  }

  function openAccount() {
    setAvatarPanel(false);   // 两个编辑器不该同时在场(头像面板是行内的)
    var m = document.getElementById('account-modal');
    if (!m) return;
    m.classList.add('open');
    document.body.classList.add('has-dialog');   // 锁背景滚动(profile 专属类,不动 .modal-open)
    // 焦点给关闭钮而非第一个输入框:手机上自动聚焦输入框会弹软键盘、盖住弹窗内容
    var c = document.getElementById('account-close');
    if (c) c.focus();
  }

  function closeAccount() {
    var m = document.getElementById('account-modal');
    if (!m) return;
    m.classList.remove('open');
    document.body.classList.remove('has-dialog');
    var b = document.getElementById('account-btn');
    if (b) b.focus();        // 焦点还给触发器
  }

  /** 弹窗内焦点环绕(Tab 不逃逸到背后页面)+ Esc 关闭 */
  function accountKeydown(e) {
    if (!isAccountOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); closeAccount(); return; }
    if (e.key !== 'Tab') return;
    var card = document.querySelector('#account-modal .modal-card');
    if (!card) return;
    var nodes = card.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
    var list = Array.prototype.filter.call(nodes, function (el) {
      return !el.disabled && el.getClientRects().length > 0;
    });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    Auth.renderAuthLink(document.getElementById('auth-link'));

    Auth.requireSession(document.getElementById('auth-gate'), function (u) {
      user = u;
      var box = document.getElementById('profile-box');
      box.hidden = false;

      document.getElementById('profile-name').textContent = u.username;
      document.getElementById('profile-meta').textContent =
        '注册于 ' + (u.created_at || '').slice(0, 10);
      document.getElementById('profile-role').hidden = u.role !== 'admin';
      document.getElementById('admin-link').hidden = u.role !== 'admin';

      renderAvatar();
      renderPicker();

      // 头像下拉开关与外部点击收起
      document.getElementById('avatar-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        setAvatarPanel(document.getElementById('avatar-panel').hidden);
      });
      document.addEventListener('click', function (e) {
        var pnl = document.getElementById('avatar-panel');
        var btn = document.getElementById('avatar-btn');
        if (!pnl || pnl.hidden) return;
        if (!pnl.contains(e.target) && !btn.contains(e.target)) {
          setAvatarPanel(false);
        }
      });
      // Esc 收起下拉并把焦点还给触发器
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var pnl = document.getElementById('avatar-panel');
        if (!pnl || pnl.hidden) return;
        setAvatarPanel(false);
        document.getElementById('avatar-btn').focus();
      });
      // 上传图标是 <button>(label 不可聚焦);点击后转交给隐藏的 file input
      var uploadBtn = document.getElementById('avatar-upload-btn');
      if (uploadBtn) uploadBtn.addEventListener('click', function () {
        document.getElementById('avatar-file').click();
      });
      // 本地文件 → 压缩 → 上传 → 落库(即时生效,无 Save)
      document.getElementById('avatar-file').addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        var msg = document.getElementById('avatar-msg');
        showMsg(msg, '处理中…', 'info');
        PortraitUpload.toDataUrl(f)
          .then(function (out) { return PortraitUpload.upload(out.data, out.mime); })
          .then(function (url) { return saveAvatar(url, msg); })
          .then(function (v) {
            if (v == null) return;
            user.avatar_url = v;
            renderAvatar();
          })
          .catch(function (err) {
            showMsg(msg, (err && err.message) || '上传失败,请重试');
          });
      });

      // 退出登录按钮
      var logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', function () {
          Auth.request('POST', '/api/auth/logout', {}).then(function () {
            try { sessionStorage.removeItem('auth_user'); } catch (e) {}
            location.href = '/';
          });
        });
      }

      // 账号设置弹窗(用户名 + 密码同一处):关闭钮 / 遮罩点击 / Esc 三路可关
      document.getElementById('account-btn').addEventListener('click', openAccount);
      document.getElementById('account-close').addEventListener('click', closeAccount);
      document.querySelector('#account-modal .modal-backdrop').addEventListener('click', closeAccount);
      document.addEventListener('keydown', accountKeydown);
      document.getElementById('rename-save').addEventListener('click', function () {
        var next = document.getElementById('rename-name').value.trim();
        var pass = document.getElementById('rename-pass').value;
        var msg = document.getElementById('rename-msg');
        if (!next || !pass) { showMsg(msg, '请填写新用户名与当前密码'); return; }
        Auth.request('POST', '/api/auth/username', { username: next, password: pass }).then(function (r) {
          if (!r.ok) { showMsg(msg, r.data.error || '修改失败'); return; }
          user.username = r.data.username;
          document.getElementById('profile-name').textContent = user.username;
          // 顶栏同步:renderAuthLink 内部 me(true) 拉新名,username 变更检测触发重渲(不整页刷新)
          Auth.renderAuthLink(document.getElementById('auth-link'));
          showMsg(msg, '用户名已更新', 'ok');
          document.getElementById('rename-name').value = '';
          document.getElementById('rename-pass').value = '';
          // 成功后不关弹窗:关掉会连带收起密码表单、也看不见这行提示
        });
      });

      // 收藏搜索 + 分页(客户端;搜索作用于全部收藏,不是当前页 —— 契约 design.md §2.4)
      var favSearch = document.getElementById('fav-search');
      if (favSearch) favSearch.addEventListener('input', function () {
        favQueryRaw = favSearch.value.trim();
        favQuery = favQueryRaw.toLowerCase();              // 不防抖:数据在本地、每页 ≤12 张卡
        favPage = 1;                                        // 搜索必回第 1 页
        renderFavs();
      });
      var favClear = document.getElementById('fav-search-clear');
      if (favClear) favClear.addEventListener('click', function () {
        if (favSearch) { favSearch.value = ''; favSearch.focus(); }
        favQuery = '';
        favQueryRaw = '';
        favPage = 1;
        renderFavs();
      });
      var favPrev = document.getElementById('fav-prev');
      if (favPrev) favPrev.addEventListener('click', function () { favPage -= 1; renderFavs(); });
      var favNext = document.getElementById('fav-next');
      if (favNext) favNext.addEventListener('click', function () { favPage += 1; renderFavs(); });

      loadFavs();
      fetch('/api/my-submissions').then(function (r) { return r.json(); }).then(renderStats).catch(function () {});

      document.getElementById('pw-btn').addEventListener('click', function () {
        var oldPw = document.getElementById('pw-old').value;
        var newPw = document.getElementById('pw-new').value;
        var msg = document.getElementById('pw-msg');
        if (!oldPw || !newPw) { showMsg(msg, '请填写旧密码与新密码'); return; }
        Auth.request('POST', '/api/auth/password', { old_password: oldPw, new_password: newPw }).then(function (r) {
          if (r.ok) {
            showMsg(msg, '密码已修改,请重新登录。', 'ok');
            Auth.request('POST', '/api/auth/logout', {}).then(function () {
              setTimeout(function () { location.href = '/profile'; }, 900);
            });
          } else {
            showMsg(msg, r.data.error || '修改失败');
          }
        });
      });
    });
  });
})();
