/* src/stats.js —— review 统计看板(admin+authed 只读)
 *
 * GET /api/stats:单包返回内容口径聚合,供 review「统计」tab 渲染。
 * 数据口径 / 字段名 / SQL 严格照 design.md §3 / §4:
 *   分布区块(年份/城市/类型)= 已通过演出;by_singer = 全部非删演出;
 *   时间线区块(提交/审核)= 近 30 天按天;全部排除 is_deleted=1。
 *   用户相关聚合(top_contributors / user_registrations)已移入访问分析(/api/pageview)。
 * 全部静态 SQL 无用户输入,直接 prepare().all()(全参数化,无 `${}` 插值)。
 * 权限:requireAdminAuthed(admin + 审核密码解锁);GET 只读,无 CSRF、不加限流。
 */
import { json, requireAdmin, isAdminAuthed, HttpError } from './db.js';

async function requireAdminAuthed(request, env) {
  const user = await requireAdmin(request, env);
  if (!(await isAdminAuthed(request, env, user.id))) throw new HttpError(403, '需先输入审核密码解锁');
  return user;
}

/** 数字归一:D1/SQLite 可能返回 bigint 或字符串,统一 Number() */
function num(v) {
  return Number(v);
}

export async function handleStats(request, env) {
  await requireAdminAuthed(request, env);
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  // totals
  const { results: totals } = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM performances WHERE is_deleted=0) AS total,
       (SELECT COUNT(*) FROM performances WHERE status='approved' AND is_deleted=0) AS approved,
       (SELECT COUNT(*) FROM performances WHERE status='pending'  AND is_deleted=0) AS pending,
       (SELECT COUNT(*) FROM performances WHERE status='rejected' AND is_deleted=0) AS rejected,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM singers WHERE active=1) AS singers`
  ).all();
  const t = totals[0] || {};

  // by_singer(全部非删;含 rejected 于 total)
  const { results: bySinger } = await env.DB.prepare(
    `SELECT s.id, s.name_zh,
       SUM(CASE WHEN p.status='approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN p.status='pending'  THEN 1 ELSE 0 END) AS pending,
       COUNT(p.id) AS total
     FROM singers s LEFT JOIN performances p ON p.singer=s.id AND p.is_deleted=0
     GROUP BY s.id ORDER BY s.sort_order, s.id`
  ).all();

  // by_year / by_city / by_type(仅 approved)
  const { results: byYear } = await env.DB.prepare(
    `SELECT year, COUNT(*) AS count FROM performances WHERE status='approved' AND is_deleted=0 GROUP BY year ORDER BY year DESC`
  ).all();
  const { results: byCity } = await env.DB.prepare(
    `SELECT city, COUNT(*) AS count FROM performances WHERE status='approved' AND is_deleted=0 GROUP BY city ORDER BY count DESC LIMIT 10`
  ).all();
  const { results: byType } = await env.DB.prepare(
    `SELECT type, COUNT(*) AS count FROM performances WHERE status='approved' AND is_deleted=0 GROUP BY type ORDER BY count DESC`
  ).all();

  // timeline(近 30 天按 created_at)
  const { results: timeline } = await env.DB.prepare(
    `SELECT date(created_at) AS d,
       SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
     FROM performances WHERE is_deleted=0 AND created_at >= datetime('now','-29 days')
     GROUP BY d ORDER BY d`
  ).all();

  // review_flow(近 30 天按 reviewed_at,通过/驳回)
  const { results: reviewFlow } = await env.DB.prepare(
    `SELECT date(reviewed_at) AS d,
       SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
     FROM performances WHERE is_deleted=0 AND reviewed_at IS NOT NULL AND reviewed_at >= datetime('now','-29 days')
     GROUP BY d ORDER BY d`
  ).all();

  // (top_contributors / user_registrations 与用户相关,已移入 /api/witness?action=stats 的
  //  访问分析;此处仅保留内容口径分布)
  // top_tags(仅 approved 演出上的 approved 标签)
  const { results: topTags } = await env.DB.prepare(
    `SELECT t.name, c.name AS category, COUNT(pt.performance_id) AS count
     FROM performance_tags pt
     JOIN tags t ON t.id = pt.tag_id
     JOIN tag_categories c ON c.id = t.category_id
     JOIN performances p ON p.id = pt.performance_id AND p.status='approved' AND p.is_deleted=0
     WHERE t.status='approved' AND c.status='approved'
     GROUP BY pt.tag_id ORDER BY count DESC LIMIT 10`
  ).all();

  // singer_requests:status 计数 + meta_intent 计数 → 聚合对象
  const { results: reqStatus } = await env.DB.prepare(
    'SELECT status, COUNT(*) AS count FROM singer_requests GROUP BY status'
  ).all();
  const { results: reqIntent } = await env.DB.prepare(
    'SELECT meta_intent, COUNT(*) AS count FROM singer_requests GROUP BY meta_intent'
  ).all();
  const singerRequests = { pending: 0, approved: 0, rejected: 0, provide: 0, want: 0 };
  for (const r of reqStatus) singerRequests[r.status] = num(r.count);
  for (const r of reqIntent) singerRequests[r.meta_intent] = num(r.count);

  return json({
    totals: {
      total: num(t.total),
      approved: num(t.approved),
      pending: num(t.pending),
      rejected: num(t.rejected),
      users: num(t.users),
      singers: num(t.singers),
    },
    by_singer: bySinger.map((r) => ({
      id: r.id,
      name_zh: r.name_zh || '',
      approved: num(r.approved),
      pending: num(r.pending),
      total: num(r.total),
    })),
    by_year: byYear.map((r) => ({ year: num(r.year), count: num(r.count) })),
    by_city: byCity.map((r) => ({ city: r.city || '', count: num(r.count) })),
    by_type: byType.map((r) => ({ type: r.type || '', count: num(r.count) })),
    timeline: timeline.map((r) => ({
      date: r.d || '',
      approved: num(r.approved),
      pending: num(r.pending),
      rejected: num(r.rejected),
    })),
    review_flow: reviewFlow.map((r) => ({
      date: r.d || '',
      approved: num(r.approved),
      rejected: num(r.rejected),
    })),
    top_tags: topTags.map((r) => ({
      name: r.name || '',
      category: r.category || '',
      count: num(r.count),
    })),
    singer_requests: singerRequests,
  });
}
