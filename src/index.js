/* src/index.js —— Worker 入口:路由分发 + SPA fallback + 冷启动建表
 *
 * 路由:
 *   /api/*           JSON 接口(auth / performances / singers / submissions / review)
 *   /singer/{singer} 回退 singer.html(地图页)
 *   其余             静态资源;未命中回退 index.html
 */
import { json, HttpError, ensureSchema, cleanupTrash, cleanupRateLimits } from './db.js';
import { handleAuth } from './auth.js';
import { handlePerformances } from './performances.js';
import { handleSingers, handleSingerRequests } from './singers.js';
import { handleSingerIntros } from './singer-intros.js';
import { handleSubmissions } from './submissions.js';
import { handleReview } from './review.js';
import { handleTags, handlePerfTags } from './tags.js';
import { handleCities, handleGeocode } from './cities.js';
import { handleVideoMeta, handleMissingVideoMeta } from './video-meta.js';
import { handleStats } from './stats.js';
import { handleContributors } from './contributors.js';
import { handleReactions } from './reactions.js';
import { handleFavorites } from './favorites.js';
import { handlePortraitUpload, servePortraitImage } from './uploads.js';
import { handlePageview } from './pageview.js';

let schemaReady = false;

/* ---------- 匿名公开读的边缘缓存(Cache API) ----------
 * 公开 GET 端点的高频读(每次歌手页加载 = 5 个 /api 请求)走 caches.default:
 * 命中即零 D1,返回同构响应 —— 把 D1 行读配额与首屏时延一起压掉(见 analysis 结论)。
 *
 * 触发条件(全部满足才查/存,否则原逻辑直通):
 *   - pathname 命中白名单(method GET 且带 query 也算,键=完整 URL,天然区分 ?singer=/年份)
 *   - 无 sid 会话 cookie:登录请求的 /api/performances 带 mine/favorited 会话态、
 *     /api/reactions 带 mine,必须走原逻辑,绝不可用匿名快照顶替(会丢/错会话字段);
 *     csrf/admin_key 不改公开读响应体,不算登录
 *   - 响应 200 且无 Set-Cookie(防把会话副作用缓存进去)
 *
 * 存储对象带 max-age 与 s-maxage(=TTL)供 CF Cache API 定寿命(实测 CF 命中时会把
 * max-age 回填成自身缺省 14400,故浏览器侧缓存寿命必须在【命中直出】时覆写,见下)。
 * 登录请求与写响应无 Cache-Control(浏览器不缓存)。部署验证带 ?cb=/?probe= 会生成
 * 不同键 → 恒绕过。 */
const PUBLIC_CACHE_TTL = {
  '/api/performances': 180, // 歌手页主数据(3 分钟;含收藏态除外)
  '/api/tags': 180,
  '/api/singers': 300,      // 首页卡片 + 歌手页 meta(变更低频)
  '/api/contributors': 300, // 首页现场统计与星图贡献者
  '/api/cities': 300,       // 城市坐标库(审核通过才自增长)
  '/api/reactions': 60,     // 公开计数(弹窗预取;会话 mine 除外)
  '/api/video-meta': 180,   // 提交页「解析」结果(重复解析不再打上游/D1)
};

/** 包含会话私有字段(mine/favorited)的端点:仅未登录(无 sid)走快照;其余公共端点对所有人均可走边缘缓存 */
const SESSION_SENSITIVE_ENDPOINTS = new Set(['/api/performances', '/api/reactions']);

/** 安全响应头:所有响应统一追加;CSP 与内联 SVG 地图 / 404 页内联 style 兼容;
 * img-src 含 https: 以显示歌手外链大头照(portrait URL,用户决策,见 spec/backend/security.md) */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; connect-src 'self'; font-src 'self'; " +
    "object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function withSecurityHeaders(res, request) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (request.url.startsWith('https://')) headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // schema 只对 /api/* 请求引导(且版本门命中后稳态为 0~1 次 D1);
      // 静态路径(HTML/CSS/JS/SVG、/singer SPA、404)完全不碰 D1 —— 首页首字节不再等建表(冷启动提速)。
      if (url.pathname.startsWith('/api/') && !schemaReady) {
        await ensureSchema(env);
        schemaReady = true;
      }
      // 回收站 + 限流表滚动清理(geoguide 模式:非 GET 写请求顺带执行,无独立定时器)。失败不影响主流程。
      if (url.pathname.startsWith('/api/') && request.method !== 'GET') {
        try { await cleanupTrash(env); } catch (e) { /* ignore */ }
        try { await cleanupRateLimits(env); } catch (e) { /* ignore */ }
      }
      // 公开读边缘缓存:纯公共静态端点(singers/tags/cities/video-meta)无会话态,对所有人(含登录用户)统一走边缘缓存;
      // 仅包含 mine/favorited 私有状态的端点在携带 sid cookie 时才直通 D1 计算。
      const canCache = typeof caches !== 'undefined' && !!ctx && typeof ctx.waitUntil === 'function';
      const cacheTtl = canCache ? PUBLIC_CACHE_TTL[url.pathname] : undefined;
      const isSessionSensitive = SESSION_SENSITIVE_ENDPOINTS.has(url.pathname);
      const hasSid = /(?:^|;\s*)sid=/.test(request.headers.get('cookie') || '');
      const isCacheable = cacheTtl != null && request.method === 'GET' && (!isSessionSensitive || !hasSid);

      // cacheKey 命中时返回、未命中时写缓存都用同一把;声明在外层避免块作用域逃逸(ReferenceError)。
      const cacheKey = isCacheable ? new Request(url.toString(), { method: 'GET' }) : null;
      if (isCacheable) {
        const hit = await caches.default.match(cacheKey);
        if (hit) {
          // CF Cache API 命中直出:下发客户端短缓存 + SWR(stale-while-revalidate),
          // 保证无论公共端点还是未登录演出数据,预热(prefetch)后在浏览器内存均可 0ms 秒开！
          const hh = new Headers(hit.headers);
          const clientMaxAge = isSessionSensitive ? 60 : 120;
          hh.set('Cache-Control', 'public, max-age=' + clientMaxAge + ', s-maxage=' + cacheTtl + ', stale-while-revalidate=300');
          return withSecurityHeaders(
            new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hh }),
            request
          );
        }
      }
      const res = withSecurityHeaders(await route(request, env, url), request);
      // 只有真正落库/生成的 200 无 Set-Cookie 响应才写缓存;失败/4xx 概不缓存(防上游故障被缓存)。
      if (isCacheable && res.status === 200 && !res.headers.get('set-cookie')) {
        const h = new Headers(res.headers);
        const clientMaxAge = isSessionSensitive ? 60 : 120;
        h.set('Cache-Control', 'public, max-age=' + clientMaxAge + ', s-maxage=' + cacheTtl + ', stale-while-revalidate=300');
        const store = new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers: h });
        ctx.waitUntil(caches.default.put(cacheKey, store).catch((e) => {
          console.error('public cache put error:', e && e.message || e);
        }));
      }
      return res;
    } catch (err) {
      if (err instanceof HttpError) return withSecurityHeaders(json({ error: err.message }, err.status), request);
      console.error('worker error:', err && err.stack || err);
      return withSecurityHeaders(json({ error: '服务器错误' }, 500), request);
    }
  }
};

async function route(request, env, url) {
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/performances') return handlePerformances(request, env, url);
    if (pathname === '/api/reactions') return handleReactions(request, env, url);
    if (pathname === '/api/favorites') return handleFavorites(request, env, url);
    if (pathname === '/api/singers' || pathname.startsWith('/api/singers/')) return handleSingers(request, env, url);
    if (pathname === '/api/singer-requests' || pathname.startsWith('/api/singer-requests/')) return handleSingerRequests(request, env, url);
    if (pathname === '/api/singer-intros' || pathname.startsWith('/api/singer-intros/')) return handleSingerIntros(request, env, url);
    if (pathname === '/api/tags' || pathname === '/api/tags/proposals') return handleTags(request, env, url);
    if (pathname === '/api/stats') return handleStats(request, env);
    if (pathname === '/api/contributors') return handleContributors(request, env, url);
    // 埋点/访问分析对外路径用 /api/witness 而非 pageview:浏览器广告/跟踪拦截器会拦
    // 路径含 pageview 的同源请求(ERR_BLOCKED_BY_CLIENT,review 访问分析一度全部加载失败)。
    if (pathname === '/api/witness') return handlePageview(request, env, url);
    if (pathname === '/api/uploads/portrait' && request.method === 'POST') return handlePortraitUpload(request, env);
    if (pathname === '/api/cities') return handleCities(request, env);
    if (pathname === '/api/geocode') return handleGeocode(request, env, url);
    if (pathname === '/api/video-meta/missing') return handleMissingVideoMeta(request, env, url);
    if (pathname === '/api/video-meta') return handleVideoMeta(request, env, url);
    const perfTags = pathname.match(/^\/api\/performances\/([^/]+)\/tags$/);
    if (perfTags && request.method === 'PATCH') return handlePerfTags(request, env, url, perfTags[1]);
    if (pathname.startsWith('/api/auth')) return handleAuth(request, env, url);
    if (pathname.startsWith('/api/submissions') || pathname === '/api/my-submissions') return handleSubmissions(request, env, url);
    if (pathname.startsWith('/api/review') || pathname === '/api/users' || pathname.startsWith('/api/users/') || pathname === '/api/audit') return handleReview(request, env, url);
    return json({ error: 'not found' }, 404);
  }

  // 静态资源;未命中的非 /api 路径:仅 /singer/{id} 回退地图页 SPA,
  // 其余未知路径一律 404(不再静默吞成首页,如 /r、/666)。
  // 注意:Cloudflare assets 会把 /singer.html 重定向到 /singer(clean URL),
  // 所以 fallback 直接取无扩展名路径,避免吃 307。
  // 上传大头照(/uploads/*):Worker 自吐图片,优先于静态资源,避免被 404→SPA 兜底吞掉
  const up = pathname.match(/^\/uploads\/([^/]+)$/);
  if (up && request.method === 'GET') return servePortraitImage(request, env, up[1]);
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) {
    if (pathname.startsWith('/singer/')) {
      return env.ASSETS.fetch(new Request(new URL('/singer', url).toString(), request));
    }
    // 404 内联页:不加载外部 CSS,故把所需令牌**内联定义**再消费(不能只写 var(--x) 而无定义)。
    // 值取自 /css/tokens.css 的 :root(dark 默认)与 [data-theme="light"]。
    // 唯一的外链是主题引导:它必须真的执行才有意义,而 CSP 的 `script-src 'self'` 会拒掉
    // 内联脚本(2026-09-11 前此处内联,故 404 页主题一直不跟随用户设置)。
    return new Response(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>404 · 现场档案馆</title>' +
      '<script src="/js/boot.js"><\/script>' +
      '<style>' +
      ':root{--bg:#14161d;--border:#2e3340;--text:#e8e6e1;--muted:#9aa0ad;--accent:#ff8a3d;' +
      '--r-pill:999px;--fs-2xl:1.953125rem;' +
      '--font-body:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}' +
      ':root[data-theme="light"]{--bg:#faf8f4;--border:#ded8cd;--text:#1a1d24;--muted:#5c6470;--accent:#a04a18}' +
      'body{font-family:var(--font-body);background:var(--bg);color:var(--text);margin:0;min-height:100dvh;display:grid;place-items:center}' +
      'div{text-align:center}p{color:var(--muted)}' +
      '.back{display:inline-block;margin-top:8px;color:var(--accent);text-decoration:none;border:1px solid var(--border);border-radius:var(--r-pill);padding:8px 24px}' +
      '.back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
      '</style></head><body><div><h1 style="font-size:var(--fs-2xl);margin:0">404</h1><p>页面不存在</p><a class="back" href="/">← 返回首页</a></div></body></html>',
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }
  return res;
}
