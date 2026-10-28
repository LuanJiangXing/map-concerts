/* ============================================================
   主题切换(S2,2026-09-10)
   ------------------------------------------------------------
   默认 dark(:root 即舞台夜场,不需 data-theme);点顶栏开关切到
   light = documentElement[data-theme="light"],写 localStorage 长期保持。
   首屏无闪烁由各页 <head> 的 /js/boot.js 负责(它在 tokens.css 之前恢复
   data-theme;不能内联——生产 CSP script-src 'self'),本文件只处理点击与开关状态同步。
   localStorage 不可用(隐私模式/被禁)时 try/catch 吞掉,退化为
   「本次会话内切换」。
   ============================================================ */
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function isLight() { return root.getAttribute('data-theme') === 'light'; }

  function sync() {
    var light = isLight();
    btn.setAttribute('aria-pressed', light ? 'true' : 'false');
    btn.setAttribute('aria-label', light ? '切换到夜间主题' : '切换到日间主题');
    btn.setAttribute('title', light ? '切换到夜间主题' : '切换到日间主题');
  }

  sync();

  btn.addEventListener('click', function () {
    var next = isLight() ? 'dark' : 'light';
    if (next === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('theme', next); } catch (e) { /* 隐私模式:仅本会话 */ }
    sync();
  });
})();
