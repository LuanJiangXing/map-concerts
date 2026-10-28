/* src/pageview.js —— 页面访问埋点 + review「访问分析」(仿 geoguide api/pageview,但 A 方案)
 *
 * 对外路径是 /api/witness(index.js 路由;文件/函数名沿用 pageview 是内部标识)。
 *   浏览器广告/跟踪拦截器会拦路径含 pageview 的同源请求(ERR_BLOCKED_BY_CLIENT),勿改回。
 *
 * 记录(公开):POST/GET /api/witness?page=/singer/x —— 各页尾部 analytics.js 每载入发一次。
 *   只存 page + 会话用户 id(未登录 user_id NULL),不落 IP/UA/referer(匿名仅计数不可反查)。
 *   按 IP 60/min 限流(超限静默跳过,绝不挡页面);任何失败都回 204。
 * 分析(admin + 审核密码解锁):GET /api/witness?action=stats&range=7d|30d|90d|all。
 *   返回:总访问 / 今日 / 活跃用户 / 每日访问 / Top 页面 / 用户访问榜(次数、最近·首次)
 *   / 最近访问 / Top 贡献者 / 用户注册趋势(后两者自原 /api/stats 移入,与用户相关)。
 * created_at 为 UTC(datetime('now')),前端按 +0 解析转本地展示。
 */
import { json, requireAdmin, isAdminAuthed, getSessionUser, checkRateLimit, clientIP, HttpError } from './db.js';

const RANGES = new Set(['7d', '30d', '90d', 'all']);

async function adminAuthed(request, env) {
  const user = await requireAdmin(request, env);
  if (!(await isAdminAuthed(request, env, user.id))) throw new HttpError(403, '需先输入审核密码解锁');
  return user;
}

/** 数字归一:D1/SQLite 可能返回 bigint 或字符串 */
function num(v) {
  return Number(v);
}

/** 范围谓词——不含 WHERE/AND 关键字,由调用方按自身是否已有过滤子句决定接 WHERE 还是 AND。
 * 若直接拼一段以 WHERE 开头的子句到已含 WHERE 的查询上(active_users/visitors),会得到双重 WHERE 语法错误。
 * range 已过白名单校验,replace 的数字只来自 7/30/90。 */
function rangePred(range) {
  if (range === 'all') return '';
  return "pv.created_at > datetime('now', '-" + range.replace('d', '') + " days')";
}

async function recordView(request, env, url) {
  try {
    let page = String(url.searchParams.get('page') || '/').trim();
    if (!page) page = '/';
    if (page.length > 200) page = page.slice(0, 200);
    const ip = clientIP(request);
    if (ip && ip !== 'unknown') {
      try {
        await checkRateLimit(env, 'pv:' + ip, 'pageview', 60, 60);
      } catch (e) {
        return new Response(null, { status: 204 }); // 超限:静默跳过本次
      }
    }
    let user = null;
    try { user = await getSessionUser(request, env); } catch (e) { /* 匿名 */ }
    await env.DB.prepare('INSERT INTO page_views (page, user_id) VALUES (?, ?)')
      .bind(page, user ? user.id : null).run();
  } catch (e) {
    console.error('pageview record error:', e && e.message);
  }
  return new Response(null, { status: 204 });
}

async function handleStats(request, env, url) {
  await adminAuthed(request, env);
  const range = (url.searchParams.get('range') || '30d').trim();
  if (!RANGES.has(range)) throw new HttpError(400, 'Invalid range. Use 7d, 30d, 90d, or all.');
  const pred = rangePred(range);
  const where = pred ? ' WHERE ' + pred : '';  // 无既有过滤子句的表级查询用 WHERE
  const andWhere = pred ? ' AND ' + pred : ''; // 已含 WHERE(如 user_id IS NOT NULL)的查询再接 AND

  // 计数 / 今日 / 活跃用户(有访问的注册用户,去重)
  const { results: tot } = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM page_views pv' + where
  ).all();
  const { results: today } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM page_views WHERE date(created_at) = date('now')"
  ).all();
  const { results: act } = await env.DB.prepare(
    'SELECT COUNT(DISTINCT user_id) AS n FROM page_views pv WHERE pv.user_id IS NOT NULL' + andWhere
  ).all();

  // 每日访问 / Top 页面
  const { results: daily } = await env.DB.prepare(
    'SELECT date(pv.created_at) AS d, COUNT(*) AS cnt FROM page_views pv' + where + ' GROUP BY d ORDER BY d'
  ).all();
  const { results: pages } = await env.DB.prepare(
    'SELECT pv.page AS page, COUNT(*) AS cnt FROM page_views pv' + where + ' GROUP BY pv.page ORDER BY cnt DESC LIMIT 10'
  ).all();

  // 用户访问榜(登录用户:访问次数 / 最近 / 首次)
  const { results: visitors } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(u.display_name, ''), u.username, '(未登录)') AS name,
       COUNT(*) AS visits, MAX(pv.created_at) AS last_visit, MIN(pv.created_at) AS first_visit
     FROM page_views pv JOIN users u ON u.id = pv.user_id
     WHERE pv.user_id IS NOT NULL` + andWhere +
    ' GROUP BY pv.user_id ORDER BY visits DESC LIMIT 50'
  ).all();
  // 最近访问(20,匿名显示 匿名)
  const { results: recent } = await env.DB.prepare(
    `SELECT pv.page AS page, pv.created_at AS created_at,
       COALESCE(NULLIF(u.display_name, ''), u.username) AS name
     FROM page_views pv LEFT JOIN users u ON u.id = pv.user_id
     ORDER BY pv.id DESC LIMIT 20`
  ).all();

  // 用户相关业务统计(自 /api/stats 移入,口径不变)
  const { results: topContributors } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(u.display_name, ''), u.username, '(未登录)') AS name,
       SUM(CASE WHEN p.status='approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN p.status='pending'  THEN 1 ELSE 0 END) AS pending,
       COUNT(p.id) AS total
     FROM performances p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.is_deleted=0 GROUP BY p.user_id ORDER BY total DESC LIMIT 10`
  ).all();
  const { results: userRegistrations } = await env.DB.prepare(
    `SELECT date(created_at) AS d, COUNT(*) AS count FROM users
     WHERE created_at >= datetime('now','-29 days') GROUP BY d ORDER BY d`
  ).all();

  return json({
    range,
    total_views: num(tot[0].total),
    today_views: num(today[0].n),
    active_users: num((act[0] || {}).n || 0),
    daily_views: daily.map((r) => ({ date: r.d || '', count: num(r.cnt) })),
    top_pages: pages.map((r) => ({ page: r.page || '/', count: num(r.cnt) })),
    visitors: visitors.map((r) => ({
      name: r.name || '(已注销)',
      visits: num(r.visits),
      last_visit: r.last_visit || null,
      first_visit: r.first_visit || null,
    })),
    recent: recent.map((r) => ({
      page: r.page || '/',
      name: r.name || '匿名',
      created_at: r.created_at || null,
    })),
    top_contributors: topContributors.map((r) => ({
      name: r.name || '',
      approved: num(r.approved),
      pending: num(r.pending),
      total: num(r.total),
    })),
    registrations: userRegistrations.map((r) => ({ date: r.d || '', count: num(r.count) })),
  });
}

export async function handlePageview(request, env, url) {
  const action = url.searchParams.get('action');
  if (action === 'stats') return handleStats(request, env, url);
  if (request.method !== 'POST' && request.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405);
  }
  return recordView(request, env, url);
}
