/* src/favorites.js —— 用户收藏(v9)
 *
 * 语义:登录用户收藏/取消收藏单场公开演出(bookmark)。收藏属账号私密数据:
 * GET 只回当前登录用户自己的收藏清单;写操作需登录 + CSRF。机制镜像 reactions(v8)。
 * 收藏态不落公开行/静态缓存:GET /api/performances 只在请求会话内按登录用户算 p.favorited。
 *
 * 路由:
 *   GET    /api/favorites            登录(游客 401):当前可见收藏全字段数组,收藏时间倒序
 *   POST   /api/favorites            登录+CSRF+限流 {performance_id} 加收藏(幂等)
 *   DELETE /api/favorites            登录+CSRF {performance_id} 取消收藏(幂等)
 */
import {
  json, readBody, requireUser, csrfCheck, checkRateLimit, nowStr,
  HttpError, attachLinks, attachTags, attachTracks,
} from './db.js';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** 附 singer_name(display)到演出数组:按 p.singer 一次 IN 查 singers.name_zh。 */
async function attachSingerNames(env, perfs) {
  if (!perfs.length) return;
  const ids = [...new Set(perfs.map((p) => p.singer).filter(Boolean))];
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, name_zh FROM singers WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  const nameMap = new Map(results.map((r) => [r.id, r.name_zh]));
  for (const p of perfs) p.singer_name = nameMap.get(p.singer) || p.singer;
}

/** GET:该用户当前可见(status='approved' AND is_deleted=0)的收藏演出,收藏时间倒序 */
async function readList(request, env, user) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.singer, p.year, p.date, p.title, p.type, p.venue, p.city, p.lat, p.lng, p.verified, p.note
     FROM favorites f JOIN performances p ON p.id = f.performance_id
     WHERE f.user_id = ? AND p.status = 'approved' AND p.is_deleted = 0
     ORDER BY f.created_at DESC, p.year DESC, p.date ASC`
  ).bind(user.id).all();
  const perfs = results.map((p) => ({ ...p, verified: !!p.verified, links: [], tags: [], tracks: [] }));
  await attachLinks(env, perfs);
  await attachTags(env, perfs);
  await attachTracks(env, perfs);
  await attachSingerNames(env, perfs);
  return json(perfs);
}

async function write(request, env, user, add) {
  let body = {};
  try { body = await readBody(request); } catch (e) { if (e && e.status === 413) throw e; } // 413 请求体过大照抛,勿吞成 400
  const perfId = String(body.performance_id || '');
  if (!ID_RE.test(perfId)) throw new HttpError(400, '非法演出 id');

  if (add) {
    // 只允许收藏已通过、未下架的演出(防草稿/回收站行被收藏)
    const { results } = await env.DB.prepare(
      'SELECT status, is_deleted FROM performances WHERE id = ?').bind(perfId).all();
    const p = results[0];
    if (!p) throw new HttpError(404, '演出不存在');
    if (Number(p.is_deleted) || p.status !== 'approved') throw new HttpError(400, '仅已通过的演出可收藏');
    await checkRateLimit(env, 'fav:' + user.id, 'favorite', 60, 30);
    // 幂等:重复收藏保留最早 created_at(ON CONFLICT DO NOTHING),不报错
    await env.DB.prepare(
      'INSERT INTO favorites (performance_id, user_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING'
    ).bind(perfId, user.id, nowStr()).run();
    return json({ ok: true, favorited: true });
  }

  // 取消收藏:幂等(行不存在即视为已取消)
  await env.DB.prepare(
    'DELETE FROM favorites WHERE performance_id = ? AND user_id = ?'
  ).bind(perfId, user.id).run();
  return json({ ok: true, favorited: false });
}

export async function handleFavorites(request, env, url) {
  if (request.method === 'GET') {
    const user = await requireUser(request, env); // 收藏私密:游客 401,不退化成公开清单(D1)
    return readList(request, env, user);
  }
  const user = await requireUser(request, env);
  csrfCheck(request);
  if (request.method === 'POST') return write(request, env, user, true);
  if (request.method === 'DELETE') return write(request, env, user, false);
  return json({ error: 'method not allowed' }, 405);
}
