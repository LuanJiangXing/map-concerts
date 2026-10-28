/* src/tags.js —— 标签系统:自动标签 / 公开目录 / 目录管理 / 提案审批 / 演出打标
 *
 * 权限:目录写操作(创建/改名/删除/审批)与演出打标均 requireAdmin + isAdminAuthed
 *   + csrfCheck + checkRateLimit,镜像 src/review.js 的门。
 * 自动标签:「类型」「年份」由结构化字段派生,syncAutoTags 保证与字段一致;管理员不可改。
 */

import {
  json, readBody, requireAdmin, isAdminAuthed, csrfCheck, checkRateLimit, randomHex, HttpError,
} from './db.js';

export const AUTO_CATEGORIES = ['类型', '年份'];

/** 「歌曲」类别名:社区填的歌名落此类别(普通类别,ensureSchema 预置 approved;提交页专属入口) */
export const SONG_CATEGORY = '歌曲';

const MAX_BATCH_NAMES = 50;
const MAX_TAG_IDS = 50;
const MAX_ALIASES = 20;

/** 归一化键:NFKC(全半角折叠)→ 小写 → 去空白。只折叠 Unicode/大小写/空格差异;
 *  中文数字↔阿拉伯留给别名。前后端保持同式(见 public/js/singer-tag-util.js)。 */
export function tagKey(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** aliases TEXT(换行分隔)→ 去空白数组 */
export function splitAliases(raw) {
  return String(raw || '').split('\n').map((a) => a.trim()).filter(Boolean);
}

/** 按名查类别 id(任意 status),无则 null */
export async function getCategoryIdByName(env, name) {
  const { results } = await env.DB.prepare('SELECT id FROM tag_categories WHERE name = ?').bind(name).all();
  return results[0] ? results[0].id : null;
}

/** get-or-create 类别(按 name),返回 id。新建时 sort_order = 当前最大 + 1。 */
export async function ensureCategory(env, name, status = 'approved', createdBy = '') {
  const { results } = await env.DB.prepare('SELECT id FROM tag_categories WHERE name = ?').bind(name).all();
  if (results[0]) return results[0].id;
  const { results: maxRow } = await env.DB.prepare('SELECT MAX(sort_order) AS m FROM tag_categories').all();
  const m = maxRow[0].m;
  const sortOrder = (m == null ? -1 : Number(m)) + 1;
  const id = 'cat-' + Date.now().toString(36) + '-' + randomHex(4);
  await env.DB.prepare('INSERT INTO tag_categories (id, name, sort_order, status, created_by) VALUES (?,?,?,?,?)')
    .bind(id, name, sortOrder, status, createdBy).run();
  return id;
}

/** get-or-create 标签(按 category_id+name+[singer]),返回 id。
 *  歌曲类别 singer=归属歌手(身份=(歌手,歌名),同类别内同名跨歌手各一条);非歌曲类别 singer=''。 */
export async function ensureTag(env, categoryId, name, status = 'pending', createdBy = '', singer = '') {
  const { results } = await env.DB.prepare(
    'SELECT id FROM tags WHERE category_id = ? AND name = ? AND singer_id = ?'
  ).bind(categoryId, name, singer).all();
  if (results[0]) return results[0].id;
  const id = 'tag-' + Date.now().toString(36) + '-' + randomHex(4);
  await env.DB.prepare(
    'INSERT INTO tags (id, name, category_id, status, created_by, singer_id) VALUES (?,?,?,?,?,?)'
  ).bind(id, name, categoryId, status, createdBy, singer).run();
  return id;
}

/** get-or-create 已通过标签:同名同类别已存在但非 approved(pending/rejected)→ 置 approved
 *  并清掉可能残留的提案 performance_id,保证自动标签恒为 approved 目录条目(避免与提案撞名)。 */
async function ensureApprovedTag(env, categoryId, name) {
  const id = await ensureTag(env, categoryId, name, 'approved');
  const { results } = await env.DB.prepare('SELECT status FROM tags WHERE id = ?').bind(id).all();
  if (results[0] && results[0].status !== 'approved') {
    await env.DB.prepare("UPDATE tags SET status = 'approved', performance_id = NULL WHERE id = ?").bind(id).run();
  }
  return id;
}

/** 替换演出在「类型」「年份」类别下的关联为当前值(不影响非自动标签)。
 *  type 缺失/空串时跳过类型标签;year 恒有。 */
export async function syncAutoTags(env, perf) {
  const typeCatId = await ensureCategory(env, '类型', 'approved');
  const yearCatId = await ensureCategory(env, '年份', 'approved');
  const autoCatIds = [typeCatId, yearCatId];

  const tagIds = [];
  if (perf.type) {
    tagIds.push(await ensureApprovedTag(env, typeCatId, String(perf.type)));
  }
  if (perf.year != null && perf.year !== '') {
    tagIds.push(await ensureApprovedTag(env, yearCatId, String(perf.year)));
  }

  // 先删该演出在自动类别下的旧关联,再插当前值
  await env.DB.prepare(
    `DELETE FROM performance_tags WHERE performance_id = ? AND tag_id IN (
       SELECT pt.tag_id FROM performance_tags pt
       JOIN tags t ON t.id = pt.tag_id
       JOIN tag_categories c ON c.id = t.category_id
       WHERE pt.performance_id = ? AND c.id IN (${autoCatIds.map(() => '?').join(',')})
     )`
  ).bind(perf.id, perf.id, ...autoCatIds).run();
  for (const tagId of tagIds) {
    await env.DB.prepare('INSERT OR IGNORE INTO performance_tags (performance_id, tag_id) VALUES (?,?)')
      .bind(perf.id, tagId).run();
  }
}

/** 替换演出在「非自动」类别下的关联为指定 approved 标签(「类型」「年份」不受影响)。 */
export async function replacePerfNonAutoTags(env, perfId, tagIds) {
  await env.DB.prepare(
    `DELETE FROM performance_tags WHERE performance_id = ? AND tag_id NOT IN (
       SELECT t.id FROM tags t
       JOIN tag_categories c ON c.id = t.category_id
       WHERE c.name IN ('${AUTO_CATEGORIES.join("','")}')
     )`
  ).bind(perfId).run();
  for (const tagId of tagIds) {
    await env.DB.prepare('INSERT OR IGNORE INTO performance_tags (performance_id, tag_id) VALUES (?,?)')
      .bind(perfId, tagId).run();
  }
}

/* ---------- 公开目录 GET /api/tags(?singer= 按歌手过滤计数,不传保持全库) ----------
 * v6:歌曲类别身份=(歌手,歌名)。带 ?singer= 时「歌曲」类别只列该歌手的已收录歌
 * (不含 '' 游离/未归属);非歌曲类别保持全量(仅计数按该歌手)。 */
async function handlePublicTags(env, singer) {
  const args = [];
  // 计数条件放 CASE 里而非 WHERE:无该歌手演出的标签仍以 count=0 出现(歌曲类别列表已被 singer 收窄)
  let countCond = "p.status = 'approved' AND p.is_deleted = 0";
  let whereExtra = '';
  if (singer) {
    countCond += ' AND p.singer = ?';
    args.push(singer);
    whereExtra = ' AND (c.name <> ? OR t.singer_id = ?)';
    args.push(SONG_CATEGORY, singer);
  }
  const { results } = await env.DB.prepare(
    `SELECT c.id AS category_id, c.name AS category_name, c.sort_order,
            t.id AS tag_id, t.name AS tag_name, t.aliases, t.singer_id AS tag_singer_id,
            s.name_zh AS singer_name,
            COUNT(CASE WHEN ${countCond} THEN 1 END) AS cnt
     FROM tag_categories c
     JOIN tags t ON t.category_id = c.id
     LEFT JOIN singers s ON s.id = t.singer_id
     LEFT JOIN performance_tags pt ON pt.tag_id = t.id
     LEFT JOIN performances p ON p.id = pt.performance_id
     WHERE c.status = 'approved' AND t.status = 'approved'${whereExtra}
     GROUP BY t.id, c.id, c.sort_order
     ORDER BY c.sort_order, c.id, t.name`
  ).bind(...args).all();
  const byCat = new Map();
  for (const r of results) {
    if (!byCat.has(r.category_id)) {
      byCat.set(r.category_id, { id: r.category_id, name: r.category_name, sort_order: Number(r.sort_order), tags: [] });
    }
    byCat.get(r.category_id).tags.push({
      id: r.tag_id, name: r.tag_name, aliases: splitAliases(r.aliases), count: Number(r.cnt),
      singer_id: r.tag_singer_id || '', singer_name: r.singer_name || null,
    });
  }
  const categories = [...byCat.values()].sort(
    (a, b) => (a.sort_order - b.sort_order) || (a.id < b.id ? -1 : 1)
  );
  return json({ categories });
}

/* ---------- 提案列表 GET /api/tags/proposals ---------- */
async function handleProposals(env) {
  const { results } = await env.DB.prepare(
    `SELECT t.id AS tag_id, t.name AS tag_name, t.status AS tag_status,
            t.performance_id, t.created_at, t.singer_id AS tag_singer_id,
            s.name_zh AS tag_singer_name,
            c.id AS category_id, c.name AS category_name, c.status AS category_status,
            p.title AS perf_title, p.city AS perf_city, p.edit_target_id AS perf_edit_target
     FROM tags t
     JOIN tag_categories c ON c.id = t.category_id
     LEFT JOIN singers s ON s.id = t.singer_id
     LEFT JOIN performances p ON p.id = t.performance_id
     WHERE t.status = 'pending'
     ORDER BY t.created_at ASC, t.name ASC`
  ).all();
  return json({ proposals: results.map((r) => ({
    id: r.tag_id,
    name: r.tag_name,
    category_id: r.category_id,
    category_name: r.category_name,
    category_status: r.category_status,
    singer_id: r.tag_singer_id || '',
    singer_name: r.tag_singer_name || '',
    performance_id: r.performance_id,
    perf_title: r.perf_title || '',
    perf_city: r.perf_city || '',
    perf_edit_target: r.perf_edit_target || null,
    created_at: r.created_at,
  })) });
}

/* ---------- 目录管理 / 审批 ---------- */
async function handleTagCreate(request, env, user) {
  const body = await readBody(request);
  const action = String(body.action || '');
  if (action === 'create_category') {
    const name = String(body.name || '').trim();
    if (!name || name.length > 50) throw new HttpError(400, '类别名需 1-50 字');
    if (AUTO_CATEGORIES.includes(name)) throw new HttpError(400, '「' + name + '」为内置类别,不可创建');
    const existing = await getCategoryIdByName(env, name);
    if (existing) throw new HttpError(409, '类别已存在');
    const id = await ensureCategory(env, name, 'approved', user.id);
    return json({ ok: true, id }, 201);
  }
  if (action === 'create_tags_batch') {
    const categoryId = String(body.category_id || '');
    const names = (Array.isArray(body.names) ? body.names : [])
      .map((n) => String(n).trim()).filter(Boolean).slice(0, MAX_BATCH_NAMES);
    if (!categoryId) throw new HttpError(400, '请选择类别');
    if (!names.length) throw new HttpError(400, '请填写至少一个标签名');
    const { results: cats } = await env.DB.prepare('SELECT id, status, name FROM tag_categories WHERE id = ?').bind(categoryId).all();
    if (!cats[0]) throw new HttpError(404, '类别不存在');
    if (cats[0].status !== 'approved') throw new HttpError(400, '只能往已通过类别加标签');
    if (AUTO_CATEGORIES.includes(cats[0].name)) throw new HttpError(400, '「类型」「年份」为自动类别,不可手动加标签');
    const created = [];
    const isSong = cats[0].name === SONG_CATEGORY;
    // 歌曲类别批量建标签需归属歌手(否则成 '' 游离,不进建议);非歌曲类别忽略 singer_id
    const singer = isSong ? String(body.singer_id || '').trim() : '';
    if (isSong && !singer) throw new HttpError(400, '歌曲标签须归属歌手');
    for (const name of names) {
      if (name.length > 50) throw new HttpError(400, '标签名「' + name + '」过长(≤50)');
      created.push(await ensureTag(env, categoryId, name, 'approved', user.id, singer));
    }
    return json({ ok: true, ids: created }, 201);
  }
  throw new HttpError(400, 'action 必须是 create_category 或 create_tags_batch');
}

async function handleTagPatch(request, env) {
  const body = await readBody(request);
  const action = String(body.action || '');
  if (action === 'rename_category') {
    const id = String(body.id || '');
    const name = String(body.name || '').trim();
    if (!id || !name || name.length > 50) throw new HttpError(400, '参数错误');
    if (AUTO_CATEGORIES.includes(name)) throw new HttpError(400, '「' + name + '」为内置类别名,不可重命名到该名');
    const { results: cats } = await env.DB.prepare('SELECT name FROM tag_categories WHERE id = ?').bind(id).all();
    if (!cats[0]) throw new HttpError(404, '类别不存在');
    if (AUTO_CATEGORIES.includes(cats[0].name)) throw new HttpError(400, '内置类别不可重命名');
    await env.DB.prepare('UPDATE tag_categories SET name = ? WHERE id = ?').bind(name, id).run();
    return json({ ok: true });
  }
  if (action === 'rename_tag') {
    const id = String(body.id || '');
    const name = String(body.name || '').trim();
    if (!id || !name || name.length > 50) throw new HttpError(400, '参数错误');
    const { results: tags } = await env.DB.prepare(
      'SELECT t.id, c.name AS cat_name FROM tags t JOIN tag_categories c ON c.id = t.category_id WHERE t.id = ?'
    ).bind(id).all();
    if (!tags[0]) throw new HttpError(404, '标签不存在');
    if (AUTO_CATEGORIES.includes(tags[0].cat_name)) throw new HttpError(400, '自动标签不可重命名');
    await env.DB.prepare('UPDATE tags SET name = ? WHERE id = ?').bind(name, id).run();
    return json({ ok: true });
  }
  if (action === 'set_aliases') {
    const id = String(body.id || '');
    const raw = (Array.isArray(body.aliases) ? body.aliases : []).map((a) => String(a).trim()).filter(Boolean).slice(0, MAX_ALIASES);
    for (const a of raw) if (a.length > 50) throw new HttpError(400, '别名「' + a + '」过长(≤50)');
    const { results: tags } = await env.DB.prepare(
      'SELECT t.id, t.name, c.name AS cat_name FROM tags t JOIN tag_categories c ON c.id = t.category_id WHERE t.id = ?'
    ).bind(id).all();
    const t = tags[0];
    if (!t) throw new HttpError(404, '标签不存在');
    if (AUTO_CATEGORIES.includes(t.cat_name)) throw new HttpError(400, '自动标签不可设别名');
    const seen = new Set([t.name]);
    const clean = [];
    for (const a of raw) { if (a !== t.name && !seen.has(a)) { seen.add(a); clean.push(a); } }
    await env.DB.prepare('UPDATE tags SET aliases = ? WHERE id = ?').bind(clean.join('\n'), id).run();
    return json({ ok: true, aliases: clean });
  }
  if (action === 'batch') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 100);
    const op = String(body.op || '');
    if (!ids.length || !['approve', 'reject', 'delete'].includes(op)) throw new HttpError(400, '参数错误');
    if (op === 'delete') {
      const { results: tags } = await env.DB.prepare(
        `SELECT t.id, c.name AS cat_name FROM tags t
         JOIN tag_categories c ON c.id = t.category_id
         WHERE t.id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids).all();
      for (const t of tags) {
        if (AUTO_CATEGORIES.includes(t.cat_name)) throw new HttpError(400, '自动标签不可删除');
      }
      if (tags.length) {
        const validIds = tags.map((t) => t.id);
        await env.DB.prepare(
          `DELETE FROM performance_tags WHERE tag_id IN (${validIds.map(() => '?').join(',')})`
        ).bind(...validIds).run();
        await env.DB.prepare(
          `DELETE FROM tags WHERE id IN (${validIds.map(() => '?').join(',')})`
        ).bind(...validIds).run();
      }
      return json({ ok: true, deleted: tags.length });
    }
    for (const id of ids) {
      if (op === 'approve') await approveProposal(env, id);
      else await env.DB.prepare("UPDATE tags SET status = 'rejected' WHERE id = ? AND status = 'pending'").bind(id).run();
    }
    return json({ ok: true });
  }
  if (action === 'batch_delete') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(Boolean).slice(0, 500);
    if (!ids.length) throw new HttpError(400, '请选择要删除的标签');
    const { results: tags } = await env.DB.prepare(
      `SELECT t.id, c.name AS cat_name FROM tags t
       JOIN tag_categories c ON c.id = t.category_id
       WHERE t.id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    for (const t of tags) {
      if (AUTO_CATEGORIES.includes(t.cat_name)) throw new HttpError(400, '自动标签不可删除');
    }
    if (tags.length) {
      const validIds = tags.map((t) => t.id);
      await env.DB.prepare(
        `DELETE FROM performance_tags WHERE tag_id IN (${validIds.map(() => '?').join(',')})`
      ).bind(...validIds).run();
      await env.DB.prepare(
        `DELETE FROM tags WHERE id IN (${validIds.map(() => '?').join(',')})`
      ).bind(...validIds).run();
    }
    return json({ ok: true, deleted: tags.length });
  }
  throw new HttpError(400, 'action 无效');
}

async function handleTagDelete(request, env, url) {
  const type = url.searchParams.get('type');
  const id = String(url.searchParams.get('id') || '');
  const idsParam = String(url.searchParams.get('ids') || '');

  if (type === 'batch' || idsParam) {
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
    if (!ids.length) throw new HttpError(400, '缺少 ids');
    const { results: tags } = await env.DB.prepare(
      `SELECT t.id, c.name AS cat_name FROM tags t
       JOIN tag_categories c ON c.id = t.category_id
       WHERE t.id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    for (const t of tags) {
      if (AUTO_CATEGORIES.includes(t.cat_name)) throw new HttpError(400, '自动标签不可删除');
    }
    if (tags.length) {
      const validIds = tags.map((t) => t.id);
      await env.DB.prepare(
        `DELETE FROM performance_tags WHERE tag_id IN (${validIds.map(() => '?').join(',')})`
      ).bind(...validIds).run();
      await env.DB.prepare(
        `DELETE FROM tags WHERE id IN (${validIds.map(() => '?').join(',')})`
      ).bind(...validIds).run();
    }
    return json({ ok: true, deleted: tags.length });
  }
  if (!id) throw new HttpError(400, '缺少 id');
  if (type === 'category') {
    const { results: cats } = await env.DB.prepare('SELECT name FROM tag_categories WHERE id = ?').bind(id).all();
    if (!cats[0]) throw new HttpError(404, '类别不存在');
    if (AUTO_CATEGORIES.includes(cats[0].name)) throw new HttpError(400, '内置类别不可删除');
    await env.DB.prepare('DELETE FROM performance_tags WHERE tag_id IN (SELECT id FROM tags WHERE category_id = ?)').bind(id).run();
    await env.DB.prepare('DELETE FROM tags WHERE category_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM tag_categories WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (type === 'tag') {
    const { results: tags } = await env.DB.prepare(
      'SELECT t.id, c.name AS cat_name FROM tags t JOIN tag_categories c ON c.id = t.category_id WHERE t.id = ?'
    ).bind(id).all();
    if (!tags[0]) throw new HttpError(404, '标签不存在');
    if (AUTO_CATEGORIES.includes(tags[0].cat_name)) throw new HttpError(400, '自动标签不可删除');
    await env.DB.prepare('DELETE FROM performance_tags WHERE tag_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(400, 'type 必须是 category 或 tag');
}

/** 批准单个提案:类别 pending → 置 approved;同类别已 approved 且名字/别名归一命中
 *  (含纯同名)→ 把待批名并入该 approved 的别名、删除提案行仅关联该 approved;
 *  performance_id(草稿解析为 edit_target_id)写 performance_tags。行不存在 → no-op。 */
export async function approveProposal(env, tagId) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, category_id, status, performance_id, singer_id FROM tags WHERE id = ?'
  ).bind(tagId).all();
  const tag = results[0];
  if (!tag) return;
  await env.DB.prepare("UPDATE tag_categories SET status = 'approved' WHERE id = ? AND status = 'pending'").bind(tag.category_id).run();

  // 合并候选限同 singer(歌曲类别身份=(歌手,歌名);非歌曲类别 singer_id='' 保持全局)
  const { results: approved } = await env.DB.prepare(
    "SELECT id, name, aliases FROM tags WHERE category_id = ? AND singer_id = ? AND status = 'approved' AND id != ?"
  ).bind(tag.category_id, tag.singer_id || '', tag.id).all();
  const key = tagKey(tag.name);
  let fold = null;
  for (const a of approved) {
    if (tagKey(a.name) === key) { fold = a; break; }
    if (splitAliases(a.aliases).some((x) => tagKey(x) === key)) { fold = a; break; }
  }

  let finalTagId = tag.id;
  if (fold) {
    finalTagId = fold.id;
    if (fold.name !== tag.name && !splitAliases(fold.aliases).includes(tag.name)) {
      await env.DB.prepare("UPDATE tags SET aliases = aliases || ? WHERE id = ?")
        .bind('\n' + tag.name, fold.id).run();
    }
    await env.DB.prepare('DELETE FROM performance_tags WHERE tag_id = ?').bind(tag.id).run();
    await env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(tag.id).run();
  } else {
    await env.DB.prepare("UPDATE tags SET status = 'approved' WHERE id = ?").bind(tag.id).run();
  }

  if (tag.performance_id) {
    const perfId = await resolvePerformanceId(env, tag.performance_id);
    if (perfId) {
      await env.DB.prepare('INSERT OR IGNORE INTO performance_tags (performance_id, tag_id) VALUES (?,?)')
        .bind(perfId, finalTagId).run();
    }
  }
}

async function resolvePerformanceId(env, performanceId) {
  const { results } = await env.DB.prepare('SELECT edit_target_id, is_deleted FROM performances WHERE id = ?').bind(performanceId).all();
  const p = results[0];
  if (!p || Number(p.is_deleted)) return null;
  return p.edit_target_id || performanceId;
}

/* ---------- 演出打标 PATCH /api/performances/:id/tags ---------- */
/** 演出结构化字段修正(admin 后台审核「修改」面板):approved / pending 且未删除可改。
 *  pending(含草稿行)也放行:审前修形式/年份/歌曲;reject 会清该行全部 performance_tags 与
 *  pending 提案,approve(合并)会把非自动标签/字段带往最终行,自动标签为共享目录,无孤儿。
 *  patch = { year?: number|string, type?: string };校验后写回 year/type 并 syncAutoTags
 *  重派生「类型/年份」自动标签。字段没变 → changed:false(不写库不 sync)。 */
export async function applyPerfFieldPatch(env, id, patch) {
  const { results } = await env.DB.prepare(
    'SELECT id, status, is_deleted, year, type FROM performances WHERE id = ?').bind(id).all();
  const p = results[0];
  if (!p || Number(p.is_deleted)) throw new HttpError(404, '演出不存在');
  if (p.status !== 'approved' && p.status !== 'pending') throw new HttpError(400, '仅已通过或待审核演出可改');

  let changed = false;
  let newYear = p.year;
  let newType = p.type;
  if (patch.year !== undefined && patch.year !== null && String(patch.year).trim() !== '') {
    const y = Number(patch.year);
    if (!Number.isInteger(y) || y < 1900 || y > 2100) throw new HttpError(400, '年份需在 1900-2100');
    if (Number(p.year) !== y) { newYear = y; changed = true; }
  }
  if (patch.type !== undefined && patch.type !== null) {
    const t = String(patch.type).trim();
    if (!t) throw new HttpError(400, '形式不能为空');
    if (t.length > 20) throw new HttpError(400, '形式过长(≤20 字)');
    if (String(p.type) !== t) { newType = t; changed = true; }
  }
  if (!changed) return { ok: true, changed: false, year: p.year, type: p.type };

  await env.DB.prepare('UPDATE performances SET year = ?, type = ? WHERE id = ?')
    .bind(newYear, newType, id).run();
  await syncAutoTags(env, { id, type: newType, year: newYear });
  return { ok: true, changed: true, year: newYear, type: newType };
}

export async function handlePerfTags(request, env, url, id) {
  const user = await requireAdminAuthed(request, env);
  csrfCheck(request);
  await checkRateLimit(env, 'tag:' + user.id, 'tag_edit', 60, 120);
  const body = await readBody(request);
  // 仅当显式携带 tag_ids 数组才做标签替换;只带 year/type 的纯字段修正不清空既有非自动标签
  const hasTags = Array.isArray(body.tag_ids);
  const tagIds = hasTags ? body.tag_ids.map(String).slice(0, MAX_TAG_IDS) : [];

  const { results: perfs } = await env.DB.prepare('SELECT id, status, is_deleted FROM performances WHERE id = ?').bind(id).all();
  const perf = perfs[0];
  if (!perf || Number(perf.is_deleted)) throw new HttpError(404, '演出不存在');
  if (perf.status !== 'approved' && perf.status !== 'pending') throw new HttpError(400, '仅已通过或待审核演出可打标');

  const valid = [];
  if (hasTags && tagIds.length) {
    const { results: tags } = await env.DB.prepare(
      `SELECT t.id, t.status, c.name AS cat_name
       FROM tags t JOIN tag_categories c ON c.id = t.category_id
       WHERE t.id IN (${tagIds.map(() => '?').join(',')})`
    ).bind(...tagIds).all();
    const byId = new Map(tags.map((t) => [t.id, t]));
    for (const tid of tagIds) {
      const t = byId.get(tid);
      if (!t || t.status !== 'approved') throw new HttpError(400, '存在无效标签');
      if (AUTO_CATEGORIES.includes(t.cat_name)) throw new HttpError(400, '自动标签不可修改');
      valid.push(tid);
    }
  }

  if (hasTags) await replacePerfNonAutoTags(env, id, valid);

  const patch = await applyPerfFieldPatch(env, id, { year: body.year, type: body.type });
  return json({ ok: true, changed: patch.changed, year: patch.year, type: patch.type });
}

/* ---------- 入口 ---------- */
async function requireAdminAuthed(request, env) {
  const user = await requireAdmin(request, env);
  if (!(await isAdminAuthed(request, env, user.id))) throw new HttpError(403, '需先输入审核密码解锁');
  return user;
}

export async function handleTags(request, env, url) {
  const method = request.method;
  const { pathname } = url;

  // 公开:GET /api/tags(?singer= 按歌手过滤计数)
  if (method === 'GET' && pathname === '/api/tags') return handlePublicTags(env, url.searchParams.get('singer'));

  // 提案列表(admin,只读 → 不强制 CSRF,镜像 review GET)
  if (pathname === '/api/tags/proposals') {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    await requireAdminAuthed(request, env);
    return handleProposals(env);
  }

  // 目录管理写操作
  if (pathname === '/api/tags') {
    const user = await requireAdminAuthed(request, env);
    csrfCheck(request);
    await checkRateLimit(env, 'tag:' + user.id, 'tag_edit', 60, 120);
    if (method === 'POST') return handleTagCreate(request, env, user);
    if (method === 'PATCH') return handleTagPatch(request, env);
    if (method === 'DELETE') return handleTagDelete(request, env, url);
    return json({ error: 'method not allowed' }, 405);
  }

  return json({ error: 'not found' }, 404);
}
