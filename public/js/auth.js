/* auth.js —— 登录态 / CSRF / 登录表单 / 导航(全站共享) */

(function () {
  'use strict';

  var current = null;
  var csrfToken = null;

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function refreshCsrf() { csrfToken = readCookie('csrf'); }

  function me(force) {
    if (current && !force) return Promise.resolve(current);
    return fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (u) {
      current = u;
      refreshCsrf();
      return u;
    }).catch(function () { current = null; return null; });
  }

  function request(method, url, body) {
    var headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    refreshCsrf();
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    return fetch(url, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    }).then(function (res) { refreshCsrf(); return res; });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var AVATAR_REV = 2;
  function avatarSrc(src) {
    if (!src || src.charAt(0) !== '/') return src || '';
    return src + (src.indexOf('?') < 0 ? '?v=' : '&v=') + AVATAR_REV;
  }

  function cachedUser() {
    try { return JSON.parse(sessionStorage.getItem('auth_user') || 'null'); } catch (e) { return null; }
  }
  function saveUser(u) {
    try { if (u) sessionStorage.setItem('auth_user', JSON.stringify(u)); else sessionStorage.removeItem('auth_user'); } catch (e) {}
  }
  function navHtml(u) {
    if (!u) return '<a href="/profile">登录 / 注册</a>';
    return '<a href="/profile">' + esc(u.username) + '</a>';
  }
  function bindLogout(el) {
    var l = el.querySelector('[data-auth-logout]');
    if (l) l.addEventListener('click', function (e) {
      e.preventDefault();
      Auth.request('POST', '/api/auth/logout', {}).then(function () {
        saveUser(null);
        location.href = '/';
      });
    });
  }

  /** 顶部导航:先按缓存立即渲染(进新页面登录态不闪),后台核对会话,有变化才更新 DOM */
  function renderAuthLink(el) {
    if (!el) return;
    el.innerHTML = navHtml(cachedUser());
    bindLogout(el);
    me(true).then(function (u) {
      var prev = cachedUser();
      // 变更检测须覆盖 navHtml 会渲染的字段。改用户名(全站生效)若只比 id/role 会漏检,
      // 顶栏留旧名(09-12 profile-redesign C-3)。username 一并比即可,无变化仍不碰 DOM。
      var changed = (u && prev)
        ? (u.id !== prev.id || u.role !== prev.role || u.username !== prev.username)
        : (u !== prev);
      saveUser(u);
      if (!changed) return; // 无变化不碰 DOM,杜绝闪动
      el.innerHTML = navHtml(u);
      bindLogout(el);
    }).catch(function () {});
  }

  /** 未登录时在容器里渲染登录/注册表单 */
  function renderAuthForm(el) {
    el.innerHTML =
      '<div class="auth-box">' +
        '<h3 class="auth-title">登录 / 注册</h3>' +
        '<p class="auth-hint">提交演出、管理自己的提交需要账号。</p>' +
        '<label class="field"><span>用户名</span><input id="auth-user" class="input" autocomplete="username" placeholder="2-20 位汉字 / 字母 / 数字 / _ -"></label>' +
        '<label class="field"><span>密码</span><input id="auth-pass" type="password" class="input" autocomplete="current-password" placeholder="至少 8 位"></label>' +
        '<div class="auth-actions">' +
          '<button type="button" class="btn" data-auth-do="login">登录</button>' +
          '<button type="button" class="btn btn--ghost" data-auth-do="register">注册</button>' +
        '</div>' +
        '<p class="auth-err" hidden></p>' +
      '</div>';
    var userEl = el.querySelector('#auth-user');
    var passEl = el.querySelector('#auth-pass');
    var errEl = el.querySelector('.auth-err');
    function submit(mode) {
      var username = userEl.value.trim();
      var password = passEl.value;
      if (!username || !password) { errEl.textContent = '请输入用户名和密码'; errEl.hidden = false; return; }
      (mode === 'login'
        ? Auth.request('POST', '/api/auth/login', { username: username, password: password })
        : Auth.request('POST', '/api/auth/register', { username: username, password: password })
      ).then(function (r) {
        if (r.ok) {
          saveUser(r.data.user || cachedUser());
          location.reload();
        }
        else { errEl.textContent = r.data.error || '失败,请重试'; errEl.hidden = false; }
      });
    }
    el.querySelector('[data-auth-do="login"]').addEventListener('click', function () { submit('login'); });
    el.querySelector('[data-auth-do="register"]').addEventListener('click', function () { submit('register'); });
    passEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit('login'); });
    userEl.focus();
  }

  /** 需要登录:已登录 → cb(user);未登录 → 渲染登录表单 */
  function requireSession(el, cb) {
    me().then(function (u) {
      if (u) { if (cb) cb(u); }
      else { renderAuthForm(el); }
    });
  }

  function currentUser() {
    return current || cachedUser();
  }

  window.Auth = {
    me: me,
    currentUser: currentUser,
    cachedUser: cachedUser,
    request: request,
    esc: esc,
    avatarSrc: avatarSrc,
    renderAuthLink: renderAuthLink,
    renderAuthForm: renderAuthForm,
    requireSession: requireSession
  };
})();
