/* src/reactions.js —— 演出 reaction(v8)
 *
 * 语义:Discord 风盖章。六选项可独立叠加(同 user 对同演出可有多行),对同一选项再点 = 取消。
 * 机制镜像 geoguide:计数按 type GROUP BY;登录 + CSRF 才能写;游客只读计数。
 * type 白名单后端权威;display 用 /images/twemoji/*.png(见 public/js/modal.js REACTIONS)。
 *
 * 路由:
 *   GET    /api/reactions?ids=a,b,c  公开(可选登录增强 mine)
 *   POST   /api/reactions            登录+CSRF {performance_id,type} 加/幂等刷新
 *   DELETE /api/reactions            登录+CSRF {performance_id,type} 取消(幂等)
 */
import { json, readBody, getSessionUser, requireUser, csrfCheck, checkRateLimit, nowStr, HttpError } from './db.js';

const REACTION_TYPES = new Set(['goat', 'skull', 'heart', 'thumbdown', 'check', 'cross']);
const MAX_IDS = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const ZERO = { goat: 0, skull: 0, heart: 0, thumbdown: 0, check: 0, cross: 0 };

/** 单场最新 reaction 态:计数(六键补 0)+ 该用户已选 */
async function reactionState(env, perfId, userId) {
  const counts = { ...ZERO };
  const { results: rows } = await env.DB.prepare(
    'SELECT type, COUNT(*) AS n FROM reactions WHERE performance_id = ? GROUP BY type'
  ).bind(perfId).all();
  for (const r of rows) counts[r.type] = Number(r.n);
  let mine = [];
  if (userId) {
    const { results: mineRows } = await env.DB.prepare(
      'SELECT type FROM reactions WHERE performance_id = ? AND user_id = ?'
    ).bind(perfId, userId).all();
    mine = mineRows.map((r) => r.type);
  }
  return { counts, mine };
}

/** 批量读:ids → { [perfId]: { counts, mine } };公开(未登录 mine=[]) */
async function readBatch(request, env, url) {
  let raw = String(url.searchParams.get('ids') || url.searchParams.get('id') || '');
  const ids = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)));
  if (ids.length > MAX_IDS) throw new HttpError(400, '单次最多 ' + MAX_IDS + ' 场演出');
  for (const id of ids) {
    if (!ID_RE.test(id)) throw new HttpError(400, '非法演出 id');
  }
  const out = {};
  for (const id of ids) out[id] = { counts: { ...ZERO }, mine: [] };
  if (!ids.length) return json({ reactions: out });

  const ph = ids.map(() => '?').join(',');
  const { results: rows } = await env.DB.prepare(
    `SELECT performance_id, type, COUNT(*) AS n FROM reactions
     WHERE performance_id IN (${ph}) GROUP BY performance_id, type`
  ).bind(...ids).all();
  for (const r of rows) {
    const st = out[r.performance_id];
    if (st) st.counts[r.type] = Number(r.n);
  }
  const me = await getSessionUser(request, env);
  if (me) {
    const { results: mineRows } = await env.DB.prepare(
      `SELECT performance_id, type FROM reactions
       WHERE performance_id IN (${ph}) AND user_id = ?`
    ).bind(...ids, me.id).all();
    for (const r of mineRows) {
      const st = out[r.performance_id];
      if (st) st.mine.push(r.type);
    }
  }
  return json({ reactions: out });
}

async function write(request, env, user, add) {
  let body = {};
  try { body = await readBody(request); } catch (e) { if (e && e.status === 413) throw e; } // 413 请求体过大照原契约抛,勿吞成 400
  const perfId = String(body.performance_id || '');
  const type = String(body.type || '');
  if (!ID_RE.test(perfId)) throw new HttpError(400, '非法演出 id');
  if (!REACTION_TYPES.has(type)) throw new HttpError(400, '未知 reaction 类型');

  if (add) {
    // 只允许对已通过、未下架的演出反应(防草稿/回收站行被刷)
    const { results } = await env.DB.prepare(
      'SELECT status, is_deleted FROM performances WHERE id = ?').bind(perfId).all();
    const p = results[0];
    if (!p) throw new HttpError(404, '演出不存在');
    if (Number(p.is_deleted) || p.status !== 'approved') throw new HttpError(400, '仅已通过的演出可反应');
    await checkRateLimit(env, 'rx:' + user.id, 'reaction', 60, 30);
    await env.DB.prepare(
      `INSERT INTO reactions (performance_id, user_id, type, created_at) VALUES (?,?,?,?)
       ON CONFLICT(performance_id, user_id, type) DO UPDATE SET created_at = excluded.created_at`
    ).bind(perfId, user.id, type, nowStr()).run();
  } else {
    // 取消:幂等(行不存在即视为已取消)
    await env.DB.prepare(
      'DELETE FROM reactions WHERE performance_id = ? AND user_id = ? AND type = ?'
    ).bind(perfId, user.id, type).run();
  }
  const st = await reactionState(env, perfId, user.id);
  return json({ ok: true, id: perfId, type, reactions: st });
}

export async function handleReactions(request, env, url) {
  if (request.method === 'GET') return readBatch(request, env, url);
  const user = await requireUser(request, env);
  csrfCheck(request);
  if (request.method === 'POST') return write(request, env, user, true);
  if (request.method === 'DELETE') return write(request, env, user, false);
  return json({ error: 'method not allowed' }, 405);
}
