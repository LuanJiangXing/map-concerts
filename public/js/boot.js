/* ============================================================
   启动引导 —— 主题恢复 + 渐进增强门控(S2 引入;2026-09-11 外置)
   ------------------------------------------------------------
   为什么外置(而不是留在 <head> 里内联):
   生产 CSP 是 `script-src 'self'`(见 src/index.js SECURITY_HEADERS),
   内联 <script> 一律被浏览器拒绝执行。内联版本自 S2 落地起在线上就
   从未生效 —— 表现为「切页面主题不保持」「.js 类加不上、fade gate
   整体失效」。外置为同源文件即可通过 CSP,无需放宽到 'unsafe-inline'
   (那等于丢掉 XSS 防护),也不走 inline hash(内容一改就静默失效,
   正是本次事故的形态)。
   必须在 tokens.css 之前同步(阻塞)执行:晚于首次绘制恢复主题会先闪
   一下夜间再变日间。
   ============================================================ */
(function () {
  try {
    if (localStorage.getItem('theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) { /* 隐私模式:localStorage 不可用 → 保持默认夜间 */ }

  // 门控只在 .js 下生效 —— JS 被禁用时页面完全可见(渐进增强)。
  document.documentElement.classList.add('js');

  function release() { document.documentElement.classList.remove('js'); }

  // 首页/歌手页的主脚本(app.js / home.js)是 body 末尾的同步脚本,会在本事件
  // 之前执行并置 __appBooted;它们自己掌握 reveal 时机(等数据到手,工具条 +
  // 地图 + 页脚同帧淡入)。其余页面(review / submit / profile / my-submissions)
  // 没有数据相关的门控元素,解析完即撤掉,不必白等 3 秒。
  function onReady() { if (!window.__appBooted) release(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // 有主脚本但接口不返回时的硬兜底,避免页面永久空白。
  setTimeout(function () { if (!window.__appReady) release(); }, 15000);
})();
