/* analytics.js —— 页面访问埋点(轻量,仿 geoguide /api/pageview 一行上报)
 * 每次页面加载把当前路径报给 Worker,记 page_views;登录用户经会话 cookie 自动关联。
 * 失败静默(sendBeacon 无回调),绝不影响页面。路径可能含中文等,已 encodeURIComponent。
 * 注意:对外路径是 /api/witness(不是 pageview)——含 pageview 的同源请求会被浏览器
 * 广告/跟踪拦截器 ERR_BLOCKED_BY_CLIENT 拦掉(2026-09-03 线上事故,勿改回)。 */
(function () {
  'use strict';
  try {
    var p = location.pathname;
    if (!p) return;
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/witness?page=' + encodeURIComponent(p));
    } else {
      fetch('/api/witness?page=' + encodeURIComponent(p), { method: 'POST', keepalive: true });
    }
  } catch (e) { /* 忽略 */ }
})();
