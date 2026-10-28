/* src/performances.js —— 公开只读:演出(带过滤)。
 * 歌手列表已迁至 src/singers.js(handleSingers,过滤 active=1)。 */
import { json, getSessionUser, attachLinks, attachTags, attachTracks } from './db.js';

export async function handlePerformances(request, env, url) {
  const q = url.searchParams;
  const conds = ["status = 'approved'", 'is_deleted = 0'];
  const args = [];
  const singer = q.get('singer');
  if (singer) { conds.push('singer = ?'); args.push(singer); }
  const year = q.get('year');
  if (year && /^\d{4}$/.test(year)) { conds.push('year = ?'); args.push(Number(year)); }
  const type = q.get('type');
  if (type) { conds.push('type = ?'); args.push(type); }

  // 排序:按**卡片显示的那个时间**降序。与 public/js/modal.js 的 dateRank() 同一套取值规则,
  // 两端必须给出同一次序(否则只读服务端顺序的消费者会看到另一种排列):
  //   'YYYY-MM-DD' → 原样;只有年份 'YYYY' → 补 '-00-00';其余(含 ''/NULL/畸形)→ 用 year 兜底。
  //
  // **不能写成 `ORDER BY year DESC, date DESC`**:库里存在 year 与 date 不一致的记录
  // (北京「中华情」year=2004 但 date=2001-01-07;高雄跨年 year=2013 但 date=2012-12-31)。
  // 按 year 当主键会把北京那条排到 2001-05-27 之前,而卡片上印的是 2001-01-07 —— 顺序与
  // 内容自相矛盾(2026-09-12 用户实测报出)。列表按什么显示,就得按什么排。
  const { results } = await env.DB.prepare(
    'SELECT id, singer, year, date, title, type, venue, city, lat, lng, verified, note ' +
    'FROM performances WHERE ' + conds.join(' AND ') +
    ' ORDER BY CASE' +
    "   WHEN date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN date" +
    "   WHEN date GLOB '[0-9][0-9][0-9][0-9]' THEN date || '-00-00'" +
    "   ELSE printf('%04d-00-00', year) END DESC"
  ).bind(...args).all();

  const perfs = results.map((p) => ({ ...p, verified: !!p.verified, links: [], tags: [], tracks: [] }));
  await attachLinks(env, perfs);
  await attachTags(env, perfs);
  await attachTracks(env, perfs);
  // v8 署名:作者 + 累计修订者(解析成 username 公开署名;仍不回发 user_id)
  await attachCredits(env, perfs);

  // 本人标记(不泄露 user_id,只给布尔):当前登录用户提交的演出 → 弹窗动作按钮显示「修改」而非「建议修改/补充」
  const me = await getSessionUser(request, env);
  if (me) {
    const { results: mineRows } = await env.DB.prepare('SELECT id FROM performances WHERE user_id = ?').bind(me.id).all();
    const mineSet = new Set(mineRows.map((r) => r.id));
    perfs.forEach((p) => { p.mine = mineSet.has(p.id); });
    // v9 收藏态(会话内动态布尔,镜像 mine):该用户收藏的演出 → 弹窗星标实心;只算当前请求,不落公共行/静态缓存
    const { results: favRows } = await env.DB.prepare(
      'SELECT performance_id FROM favorites WHERE user_id = ?'
    ).bind(me.id).all();
    const favSet = new Set(favRows.map((r) => r.performance_id));
    perfs.forEach((p) => { p.favorited = favSet.has(p.id); });
  }
  perfs.forEach((p) => {
    if (p.mine === undefined) p.mine = false;
    if (p.favorited === undefined) p.favorited = false;
  });

  return json(perfs);
}

/** 附贡献署名:作者(performances.user_id 解析 username,可空)+ 修订者(performance_credits,累计去重)。
 *  数据库写入时已排除作者,这里仍防御性过滤一次(用户名全局唯一,比 id 安全)。 */
async function attachCredits(env, perfs) {
  if (!perfs.length) return;
  const ids = perfs.map((p) => p.id);
  const author = new Map();
  const editors = new Map();
  const CHUNK = 80;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    const { results: authRows } = await env.DB.prepare(
      'SELECT p.id, u.username FROM performances p LEFT JOIN users u ON u.id = p.user_id WHERE p.id IN (' + ph + ')'
    ).bind(...chunk).all();
    for (const r of authRows || []) {
      author.set(r.id, r.username);
    }

    const { results: credRows } = await env.DB.prepare(
      'SELECT c.performance_id, u.username FROM performance_credits c JOIN users u ON u.id = c.user_id ' +
      'WHERE c.performance_id IN (' + ph + ') ORDER BY c.created_at ASC, c.user_id ASC'
    ).bind(...chunk).all();
    for (const r of credRows || []) {
      if (!editors.has(r.performance_id)) editors.set(r.performance_id, []);
      editors.get(r.performance_id).push(r.username);
    }
  }

  for (const p of perfs) {
    const au = author.get(p.id) || null;
    p.submitted_by = au;
    p.editors = (editors.get(p.id) || []).filter((n) => n !== au);
  }
}
