/* src/contributors.js —— 首页现场统计与贡献者星图公开端点
 *
 * GET /api/contributors:
 *   - 公开只读，免鉴权
 *   - 返回全站已审核演出总数 total_performances
 *   - 返回 Top 20 贡献者（按通过场次降序），含主贡献歌手列表
 *   - 附带 15 分钟边缘缓存
 */
import { json } from './db.js';

export async function handleContributors(request, env) {
  if (request.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405);
  }

  // 1. 全站已通过且未删除的演出总场次
  const { results: totalRows } = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM performances WHERE status = 'approved' AND is_deleted = 0`
  ).all();
  const totalPerformances = Number(totalRows && totalRows[0] && totalRows[0].total) || 0;

  // 2. Top 20 贡献者 (仅统计 approved 且未软删的演出，排除游客/无 user_id 记录)
  const { results: topRows } = await env.DB.prepare(
    `SELECT
       p.user_id,
       COALESCE(NULLIF(u.display_name, ''), u.username, '匿名乐迷') AS name,
       COALESCE(u.avatar_url, '') AS avatar_url,
       COUNT(p.id) AS count
     FROM performances p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.status = 'approved' AND p.is_deleted = 0
       AND p.user_id IS NOT NULL AND p.user_id != ''
     GROUP BY p.user_id
     ORDER BY count DESC
     LIMIT 20`
  ).all();

  const userIds = (topRows || []).map((r) => r.user_id);
  const userSingersMap = {};

  // 3. 聚合这些贡献者每人提交最多的歌手
  if (userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(',');
    const { results: singerRows } = await env.DB.prepare(
      `SELECT
         p.user_id,
         p.singer,
         COALESCE(s.name_zh, p.singer) AS name_zh,
         COALESCE(s.portrait, '') AS portrait,
         COUNT(p.id) AS count
       FROM performances p
       LEFT JOIN singers s ON s.id = p.singer
       WHERE p.status = 'approved' AND p.is_deleted = 0
         AND p.user_id IN (${placeholders})
       GROUP BY p.user_id, p.singer
       ORDER BY p.user_id, count DESC`
    ).bind(...userIds).all();

    (singerRows || []).forEach((r) => {
      if (!userSingersMap[r.user_id]) userSingersMap[r.user_id] = [];
      if (userSingersMap[r.user_id].length < 3) {
        userSingersMap[r.user_id].push({
          id: r.singer,
          name: r.name_zh,
          portrait: r.portrait,
          count: Number(r.count) || 0
        });
      }
    });
  }

  const contributors = (topRows || []).map((c) => ({
    user_id: c.user_id,
    name: c.name,
    avatar_url: c.avatar_url,
    count: Number(c.count) || 0,
    singers: userSingersMap[c.user_id] || []
  }));

  return json(
    {
      total_performances: totalPerformances,
      contributors
    },
    200,
    {
      'Cache-Control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600'
    }
  );
}
