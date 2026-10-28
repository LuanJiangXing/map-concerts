/* src/submissions.js —— 提交 / 我的提交
 *
 * 状态机:新提交 → pending(admin 直接 approved);
 *   编辑 own 非已审核条目(pending/rejected/草稿)→ 原地更新;
 *   编辑 approved → 生成草稿行(edit_target_id 指向原条目),审核通过后合并;
 *     admin → 草稿即刻自动通过(复用 review.applyApprove,同审核语义,不留待审)。
 */
import {
  json, readBody, requireUser, csrfCheck, checkRateLimit, attachLinks, attachTags, attachTracks,
  saveLinks, saveTracks, randomHex, nowStr, HttpError,
  softDeletePerf, restorePerf, purgePerf,
} from './db.js';
import {
  syncAutoTags, replacePerfNonAutoTags, getCategoryIdByName, ensureCategory, ensureTag, tagKey, splitAliases,
  SONG_CATEGORY, AUTO_CATEGORIES,
} from './tags.js';
import { applyApprove } from './review.js';
import { rememberCity } from './cities.js';

const TYPE_WHITELIST = ['演唱会', '音乐节', '歌友会', '签售', '其他'];
const MAX_LINKS = 10;
const MAX_SELECTED_TAGS = 50;
const MAX_PROPOSALS = 100; // 2026-09-07:整场逐曲时间轴,一场新歌可 >30(原 30 会静默截断成永久丢歌);通用提议框前端仍各自限 ≤10
const MAX_TRACKS = 100; // 整场逐曲时间轴最多行数(2026-09-07,v5)
const MAX_TRACK_SECONDS = 12 * 3600; // 时间上限 12h(bilibili 整场录像足够)
const MAX_TRACK_PART = 999; // 分 P 上限(bilibili 多 P 视频的 P 序号;v11)

/** 剥歌名尾部括号备注块:「…」/(…)/（…）/【…】/[…] (循环剥除多层,保护歌名中段括号) */
export function stripTailNote(name) {
  let s = String(name == null ? '' : name).trim();
  while (true) {
    const last = s.slice(-1);
    const prev = s;
    if (last === '」') { const i = s.lastIndexOf('「'); if (i >= 0 && i < s.length - 1) s = s.slice(0, i).trim(); }
    else if (last === '）') { const j = s.lastIndexOf('（'); if (j >= 0 && j < s.length - 1) s = s.slice(0, j).trim(); }
    else if (last === ')') { const k = s.lastIndexOf('('); if (k >= 0 && k < s.length - 1) s = s.slice(0, k).trim(); }
    else if (last === '】') { const l = s.lastIndexOf('【'); if (l >= 0 && l < s.length - 1) s = s.slice(0, l).trim(); }
    else if (last === ']') { const m = s.lastIndexOf('['); if (m >= 0 && m < s.length - 1) s = s.slice(0, m).trim(); }
    if (s === prev || !s) break;
  }
  return s || String(name || '').trim();
}

/** 清洗歌曲名中的前导前缀/序号/时间戳、尾部歌手/修饰词/备注(保留歌名中间合法冒号如 飞机场的10:30) */
export function cleanSongName(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/：/g, ':');
  if (!s) return '';

  // 1. 剥常见业务/演出环节前缀: 城市限定曲：, 点歌环节：, 安可曲：, 返场：, 首唱：
  s = s.replace(/^(?:城市限定(?:曲)?|限定曲|返场(?:曲)?|安可(?:曲)?|首唱(?:曲)?|点歌(?:环节)?|加更)[：:]\s*/i, '');

  // 2. 剥除前导外层括号包裹的时间或序号:如 [00:00]、(01:23:45)、【01】、(1)
  s = s.replace(/^(?:\[|【|\()\s*(?:\d{1,3}:[0-5]\d(?::[0-5]\d)?|\d{1,3})\s*(?:\]|】|\))\s*/, '');

  // 3. 剥除前导序号(须在剥时间前,防 01. 00:00 找自己;点后不能紧跟数字防把 6.28 误当序号):如 01. 找自己、1、找自己、01 找自己
  s = s.replace(/^\d{1,3}(?:\.(?!\d)|、)\s*/, '');
  s = s.replace(/^0\d{1,2}\s+/, '');

  // 4. 剥除前导时间戳(m:ss / h:mm:ss):如 0:00:01 找自己、0:02:50浮游、02:50 找自己 (含二次括号包裹)
  s = s.replace(/^(?:\[|【|\()\s*\d{1,3}:[0-5]\d(?::[0-5]\d)?\s*(?:\]|】|\))\s*/, '');
  s = s.replace(/^\d{1,3}:[0-5]\d(?::[0-5]\d)?\s*/, '');

  // 5. 再次检查可能残留的前导序号
  s = s.replace(/^\d{1,3}(?:\.(?!\d)|、)\s*/, '');

  // 6. 剥除尾随连接符 + 歌手/说明: 如 " - 陶喆", " / 周深", " | 现场"
  s = s.replace(/\s+[-/|—–]\s*.*$/, '');

  // 7. 剥除尾部常见视频标签/修饰词 (4K, 1080P, 现场版, 纯享版, 直拍, 完整版 等)
  s = s.replace(/\s+(?:4k|1080p\d*|720p|超清|高清|无损|纯享版|现场版|完整版|自录|自存|直拍|饭拍|伴奏|原版|首唱)$/i, '');

  // 8. 剥除尾随时长格式或纯数字日期: 如 " 04:30", " 20240810"
  s = s.replace(/\s+\d{1,3}:[0-5]\d(?::[0-5]\d)?$/, '');
  s = s.replace(/\s+(?:19|20)\d{6}$/, '');

  // 9. 剥除行尾时间戳:如 找自己 05:00、找自己 (05:00)、找自己 [01:20:30]
  s = s.replace(/(?:\s+|\s*(?:\[|【|\()\s*)\d{1,3}:[0-5]\d(?::[0-5]\d)?\s*(?:\]|】|\))?\s*$/, '');

  // 10. 剥除前导独立加号/延续符:如 ＋自己按门铃自己听 → 自己按门铃自己听
  s = s.replace(/^[+＋\s]+/, '');

  // 11. 剥除尾部各类括号备注: 「…」/(…)/（…）/【…】/[…] (循环剥除多层)
  return stripTailNote(s);
}

/** 将可能为组曲/串烧的歌名切分为单曲数组:
 *  - 识别前导组曲前缀(如 "邓丽君组曲:", "经典串烧：")并剥除
 *  - 若包含 + 或 ＋,则按加号切分为多首子歌名并逐一 cleanSongName 清洗去重
 *  - 不包含加号则直接返回 [cleanSongName(raw)] (若为空则返回 [])
 */
export function splitMedleySongs(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  s = s.replace(/^(?:.*?(?:组曲|串烧|联唱|合辑))[：:]\s*/i, '');
  if (!/[+＋]/.test(s)) {
    const c = cleanSongName(s);
    return c ? [c] : [];
  }
  const parts = s.split(/[+＋]/);
  const out = [];
  for (const p of parts) {
    const c = cleanSongName(p);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function str(v, max, label) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw new HttpError(400, `${label}过长(≤${max} 字)`);
  return s;
}

async function validateSubmission(b, env) {
  const out = {
    singer: str(b.singer, 30, '歌手'),
    year: Number(b.year),
    date: str(b.date, 20, '日期'),
    title: str(b.title, 50, '标题'),
    type: str(b.type, 20, '形式'), // 2026-09-10 起必填(原为非法/缺省静默回落 '其他',会给人「不填=演唱会/其他」的错觉)
    venue: str(b.venue, 100, '场馆'),
    city: str(b.city, 50, '城市'),
    lat: Number(b.lat),
    lng: Number(b.lng),
    note: str(b.note, 500, '备注'),
  };
  if (!out.singer) throw new HttpError(400, '歌手必填');
  // 歌手必须存在于 active singers(去掉 'david-tao' 硬编码回退)
  const { results: singers } = await env.DB.prepare(
    'SELECT id FROM singers WHERE id = ? AND active = 1'
  ).bind(out.singer).all();
  if (!singers[0]) throw new HttpError(400, '歌手不存在或未激活');
  if (!out.title) throw new HttpError(400, '标题必填');
  if (!out.city) throw new HttpError(400, '城市必填');
  if (!TYPE_WHITELIST.includes(out.type)) throw new HttpError(400, '形式必填,须为:演唱会 / 音乐节 / 歌友会 / 签售 / 其他');
  if (!Number.isFinite(out.year) || out.year < 1900 || out.year > 2100) throw new HttpError(400, '年份需在 1900-2100');
  if (!Number.isFinite(out.lat) || out.lat < -90 || out.lat > 90) throw new HttpError(400, '纬度需在 -90~90');
  if (!Number.isFinite(out.lng) || out.lng < -180 || out.lng > 180) throw new HttpError(400, '经度需在 -180~180');

  const linksArr = Array.isArray(b.links) ? b.links : [];
  if (linksArr.length > MAX_LINKS) throw new HttpError(400, '链接最多 10 条');
  const links = [];
  for (const l of linksArr) {
    const label = str(l.label, 100, '链接名');
    const url = String(l.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, '链接需以 http(s):// 开头');
    if (url.length > 200) throw new HttpError(400, '链接过长(≤200 字)');
    links.push({ label, url, is_full: !!l.is_full });
  }
  out.links = links;
  out.tracks = normalizeTracks(b.tracks, links);
  return out;
}

/** 逐曲开始时间解析(m:ss / h:mm:ss;容忍全角冒号)。返回 {sec|null}|{err}。
 *   空串 → null(唱过但没给时间);非法格式/超 12h → {err}。 */
export function parseStartTime(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/：/g, ':');
  if (!s) return { sec: null };
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return { err: true };
  const seg = parts.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  if (seg.some((n) => Number.isNaN(n))) return { err: true };
  let sec;
  if (parts.length === 2) {
    const [mm, ss] = seg;
    if (ss > 59) return { err: true };
    sec = mm * 60 + ss;
  } else {
    const [hh, mm, ss] = seg;
    if (mm > 59 || ss > 59) return { err: true };
    sec = hh * 3600 + mm * 60 + ss;
  }
  if (sec > MAX_TRACK_SECONDS) return { err: true };
  return { sec };
}

/** 是否为 bilibili 视频链接(整场逐曲时间轴 MVP 只支持它) */
export function isBilibiliUrl(raw) {
  try {
    const h = new URL(String(raw || '').trim()).hostname.toLowerCase();
    return h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv' || h.endsWith('.b23.tv');
  } catch { return false; }
}

/** 逐曲时间轴解析 + 校验。空名行整行跳过(同空链接行);有秒没名 → 400;秒可空(唱过无跳转)。
 *  part(v11)=分 P,缺省 1,须 1–999;缺省/非法(非数/0/>999)→ 400(前端粘贴段行已限 ≤999)。
 *  tracks 非空 → links 须恰好一条 is_full 且为 bilibili,否则 400;tracks 空 → 丢弃全部 is_full(空壳无意义)。 */
function normalizeTracks(rawTracks, links) {
  const arr = Array.isArray(rawTracks) ? rawTracks : [];
  if (arr.length > MAX_TRACKS) throw new HttpError(400, `曲目最多 ${MAX_TRACKS} 条`);
  const out = [];
  arr.forEach((t, i) => {
    const idx = i + 1;
    const rawName = str(t && t.name, 50, `第 ${idx} 行歌名`);
    const name = cleanSongName(rawName);
    let sec = null;
    const rawSec = t && t.seconds;
    if (typeof rawSec === 'number' && Number.isFinite(rawSec)) {
      if (rawSec < 0 || rawSec > MAX_TRACK_SECONDS) throw new HttpError(400, `第 ${idx} 行时间超出范围`);
      sec = Math.floor(rawSec);
    } else {
      const r = parseStartTime(rawSec);
      if (r.err) throw new HttpError(400, `第 ${idx} 行时间格式应为 m:ss 或 h:mm:ss`);
      sec = r.sec;
    }
    // part 校验(缺省 1;须整数 1–999)
    let part = 1;
    if (t && t.part != null && t.part !== '') {
      const rp = Number(t.part);
      if (!Number.isInteger(rp) || rp < 1 || rp > MAX_TRACK_PART) {
        throw new HttpError(400, `第 ${idx} 行分 P 无效(1-${MAX_TRACK_PART})`);
      }
      part = rp;
    }
    if (!name) {
      if (sec != null) throw new HttpError(400, `第 ${idx} 行有开始时间但没填歌名`);
      return; // 空行整行跳过
    }
    out.push({ name, seconds: sec, part });
  });
  const whole = links.filter((l) => l.is_full);
  if (out.length) {
    if (whole.length !== 1) throw new HttpError(400, '填了曲目时间,须恰好标一条整场视频链接');
    if (!isBilibiliUrl(whole[0].url)) throw new HttpError(400, '整场视频暂仅支持 B站链接');
  } else if (whole.length) {
    for (const l of links) l.is_full = false;
  }
  return out;
}

/** 校验所选已批标签:必须是 approved;返回去重后的 id 数组 */
async function resolveSelectedTags(env, tags) {
  const ids = [...new Set((Array.isArray(tags) ? tags : []).map(String).filter(Boolean).slice(0, MAX_SELECTED_TAGS))];
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, status FROM tags WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  const byId = new Map(results.map((t) => [t.id, t.status]));
  for (const id of ids) {
    if (byId.get(id) !== 'approved') throw new HttpError(400, '所选标签无效(需为已通过标签)');
  }
  return ids;
}

/** 解析 proposed 歌/标签名,返回去向报告 { attached:[], pending:[], duplicate:[] }(均为 name)。
 *  - attached:归一(name/别名折叠后)命中「已收录(approved)」→ 直接把该场挂到已收录标签,
 *    不新建提案;命中结果显示 canonical 名。
 *  - duplicate:命中已有 pending(同 category 归一同名)→ 不重复建、不指向,前端提示"同名歌审核中"(取代原静默 continue)。
 *  - pending:其余 → 新建 pending 提案,performance_id 指向 proposalTargetId(草稿 → 原条目)。
 *  attached 关联写 attachTargetId(草案/draft 行);pending 指针仍是 proposalTargetId。
 *  歌曲类别(v6):attached/duplicate/新建全部限 **同 singer** —— 身份=(歌手,歌名),跨歌手同名互不干扰。 */
async function resolveProposedTags(env, proposed, userId, proposalTargetId, attachTargetId, singer = '') {
  const list = (Array.isArray(proposed) ? proposed : []).slice(0, MAX_PROPOSALS);
  const report = { attached: [], pending: [], duplicate: [] };
  for (const p of list) {
    let name = String(p.name || '').trim();
    if (!name) continue;
    if (name.length > 50) throw new HttpError(400, '标签名「' + name + '」过长(≤50)');

    let categoryId = String(p.category_id || '').trim();
    let catName = '';
    let autoCat = false;
    if (categoryId) {
      const { results: cats } = await env.DB.prepare('SELECT id, name FROM tag_categories WHERE id = ?').bind(categoryId).all();
      if (!cats[0]) throw new HttpError(400, '所选类别不存在');
      catName = cats[0].name;
      if (AUTO_CATEGORIES.includes(catName)) autoCat = true;
    } else {
      catName = String(p.category_name || '').trim();
      if (!catName) throw new HttpError(400, '提议标签需选择类别或新建类别');
      if (catName.length > 50) throw new HttpError(400, '类别名过长(≤50)');
      if (AUTO_CATEGORIES.includes(catName)) autoCat = true;
      else {
        const existingId = await getCategoryIdByName(env, catName);
        if (existingId) categoryId = existingId;
        else categoryId = await ensureCategory(env, catName, 'pending', userId);
      }
    }
    // 「类型」「年份」为系统派生自动类别,用户不可往里提议标签(D7)
    if (autoCat) continue;

    const names = catName === SONG_CATEGORY ? splitMedleySongs(name) : [name];
    if (!names.length) continue;

    for (const singleName of names) {
      if (!singleName) continue;
      const effectiveSinger = catName === SONG_CATEGORY ? singer : '';
      const key = tagKey(singleName);

      // 1) 命中已收录:name 或任一 alias 归一相等 → 挂到 canonical(不新建;限同 singer)
      const { results: approved } = await env.DB.prepare(
        "SELECT id, name, aliases FROM tags WHERE category_id = ? AND singer_id = ? AND status = 'approved'"
      ).bind(categoryId, effectiveSinger).all();
      let hit = null;
      for (const t of approved) {
        if (tagKey(t.name) === key) { hit = t; break; }
        if (splitAliases(t.aliases).some((a) => tagKey(a) === key)) { hit = t; break; }
      }
      if (hit) {
        await env.DB.prepare('INSERT OR IGNORE INTO performance_tags (performance_id, tag_id) VALUES (?,?)')
          .bind(attachTargetId, hit.id).run();
        report.attached.push(hit.name);
        continue;
      }

      // 2) 命中已有 pending 同名(归一,同 singer)→ 提示,不重复建(不静默丢)
      const { results: pend } = await env.DB.prepare(
        "SELECT id, name FROM tags WHERE category_id = ? AND singer_id = ? AND status = 'pending'"
      ).bind(categoryId, effectiveSinger).all();
      if (pend.some((t) => tagKey(t.name) === key)) { report.duplicate.push(singleName); continue; }

      // 3) 新建 pending 提案(带 singer 归属)
      const tagId = await ensureTag(env, categoryId, singleName, 'pending', userId, effectiveSinger);
      await env.DB.prepare('UPDATE tags SET performance_id = ? WHERE id = ?').bind(proposalTargetId, tagId).run();
      report.pending.push(singleName);
    }
  }
  return report;
}

/** 删除某用户对目标演出(pending 提案挂靠的 performance_id)的旧提案 */
async function clearUserProposals(env, performanceId, userId) {
  await env.DB.prepare(
    "DELETE FROM tags WHERE performance_id = ? AND status = 'pending' AND created_by = ?"
  ).bind(performanceId, userId).run();
}

const PERF_FIELDS = 'singer, year, date, title, type, venue, city, lat, lng, note';

export async function handleSubmissions(request, env, url) {
  const method = request.method;
  const user = await requireUser(request, env);

  if (method === 'POST' && url.pathname === '/api/submissions') {
    csrfCheck(request);
    return handleCreate(request, env, user);
  }

  const m = url.pathname.match(/^\/api\/submissions\/([^/]+)$/);
  if (m && method === 'PATCH') { csrfCheck(request); return handleEdit(request, env, user, m[1]); }
  if (m && method === 'DELETE') { csrfCheck(request); return handleDelete(request, env, user, m[1]); }

  // 回收站操作(仅本人,已在回收站的行):恢复 / 彻底删除
  const rm = url.pathname.match(/^\/api\/submissions\/([^/]+)\/(restore|purge)$/);
  if (rm && method === 'POST') {
    csrfCheck(request);
    return rm[2] === 'restore'
      ? handleRestoreOwn(request, env, user, rm[1])
      : handlePurgeOwn(request, env, user, rm[1]);
  }

  if (method === 'GET' && url.pathname === '/api/my-submissions') return handleMine(request, env, user, url);

  return json({ error: 'not found' }, 404);
}

async function handleCreate(request, env, user) {
  await checkRateLimit(env, 'sub:' + user.id, 'submit', 300, 5);
  const body = await readBody(request);
  const data = await validateSubmission(body, env);
  const id = 'sub-' + Date.now().toString(36) + '-' + randomHex(4);
  const status = user.role === 'admin' ? 'approved' : 'pending';
  const reviewedAt = status === 'approved' ? nowStr() : null;
  await env.DB.prepare(
    `INSERT INTO performances (id, singer, year, date, title, type, venue, city, lat, lng, verified, note, status, user_id, reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, data.singer, data.year, data.date, data.title, data.type, data.venue, data.city, data.lat, data.lng, 0, data.note, status, user.id, reviewedAt).run();
  await saveLinks(env, id, data.links);
  await saveTracks(env, id, data.tracks);

  const selected = await resolveSelectedTags(env, body.tags);
  await replacePerfNonAutoTags(env, id, selected);
  const songReport = await resolveProposedTags(env, body.proposed_tags, user.id, id, id, data.singer);
  await syncAutoTags(env, { id, type: data.type, year: data.year });
  // admin 自动通过的快路径不经过 review.applyApprove,这里补城市库写回,与审核通过语义一致
  if (status === 'approved') await rememberCity(env, data.city, Number(data.lat), Number(data.lng));
  return json({ ok: true, id, status, song_report: songReport }, 201);
}

async function handleEdit(request, env, user, id) {
  await checkRateLimit(env, 'subedit:' + user.id, 'submit_edit', 300, 10);
  const { results } = await env.DB.prepare(
    'SELECT id, status, user_id, edit_target_id, is_deleted FROM performances WHERE id = ?').bind(id).all();
  const target = results[0];
  if (!target || Number(target.is_deleted)) throw new HttpError(404, '条目不存在');

  const body = await readBody(request);
  const data = await validateSubmission(body, env);
  const selected = await resolveSelectedTags(env, body.tags);
  // 提案挂靠目标:草稿(edit_target_id 非空)→ 原条目,避免合并后重指向(D6)
  const proposalTarget = target.edit_target_id || id;

  if (target.user_id === user.id && target.status !== 'approved') {
    // own 未审核条目(pending / rejected / 草稿):原地更新,并重建标签
    await env.DB.prepare(
      `UPDATE performances SET singer=?, year=?, date=?, title=?, type=?, venue=?, city=?, lat=?, lng=?, note=? WHERE id=?`
    ).bind(data.singer, data.year, data.date, data.title, data.type, data.venue, data.city, data.lat, data.lng, data.note, id).run();
    await saveLinks(env, id, data.links);
    await saveTracks(env, id, data.tracks);
    await replacePerfNonAutoTags(env, id, selected);
    await clearUserProposals(env, proposalTarget, user.id);
    const songReport = await resolveProposedTags(env, body.proposed_tags, user.id, proposalTarget, id, data.singer);
    await syncAutoTags(env, { id, type: data.type, year: data.year });
    return json({ ok: true, mode: 'update', song_report: songReport });
  }

  if (target.status === 'approved') {
    // 任意登录用户对已审核条目提出修改 → 生成草稿行;selected 挂草稿,提案挂原条目
    const draftId = id + '-d' + Date.now().toString(36);
    await env.DB.prepare(
      `INSERT INTO performances (id, singer, year, date, title, type, venue, city, lat, lng, verified, note, status, user_id, edit_target_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
    ).bind(draftId, data.singer, data.year, data.date, data.title, data.type, data.venue, data.city, data.lat, data.lng, 0, data.note, user.id, id).run();
    await saveLinks(env, draftId, data.links);
    await saveTracks(env, draftId, data.tracks);
    await replacePerfNonAutoTags(env, draftId, selected);
    const songReport = await resolveProposedTags(env, body.proposed_tags, user.id, id, draftId, data.singer);
    // admin 的建议修改 / 编辑任何已通过条目 → 草稿即刻自动通过。
    // 复用审核 approve 的 applyApprove(逐字段拷回原行、links/非自动标签替换、
    // 自动标签按新 type/year 重派生、rememberCity 城市库写回、删除草稿),与审核合并逐字节等价。
    if (user.role === 'admin') {
      const { results: dr } = await env.DB.prepare('SELECT * FROM performances WHERE id = ?').bind(draftId).all();
      if (dr[0]) {
        await applyApprove(env, dr[0]);
        // 09-08 决策:admin 直改他人已通过条目属维护动作,公开卡不署 admin 名。
        // applyApprove 已把 admin 记入 performance_credits,此处撤销(仅 admin 本人这次的自动通过)。
        await env.DB.prepare(
          'DELETE FROM performance_credits WHERE performance_id = ? AND user_id = ?'
        ).bind(id, user.id).run();
      }
      return json({ ok: true, mode: 'merged', id, song_report: songReport });
    }
    return json({ ok: true, mode: 'draft', draft_id: draftId, status: 'pending', song_report: songReport }, 201);
  }

  throw new HttpError(403, '无权编辑该条目');
}

async function handleMine(request, env, user, url) {
  const status = url.searchParams.get('status');
  const trash = status === 'trash';
  let sql =
    `SELECT id, singer, year, date, title, type, venue, city, lat, lng, verified, note,
            status, edit_target_id, reject_reason, reviewed_at, created_at, deleted_at
     FROM performances WHERE user_id = ? AND is_deleted = ?`;
  const args = [user.id, trash ? 1 : 0];
  if (status && !trash) { sql += ' AND status = ?'; args.push(status); }
  if (trash) {
    // 回收站只列"原条 + 游离草稿(其原条仍在线)";随原条下架的草稿不单独列出(随原条恢复/清除)
    sql += ` AND (edit_target_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM performances o WHERE o.id = performances.edit_target_id AND o.is_deleted = 1))`;
    sql += ' ORDER BY deleted_at DESC, year DESC, date ASC';
  } else {
    sql += ' ORDER BY year DESC, date ASC';
  }

  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const perfs = results.map((p) => ({
    ...p,
    verified: !!p.verified,
    links: [],
    tags: [],
    tracks: [],
    is_draft: !!p.edit_target_id,
  }));
  await attachLinks(env, perfs);
  await attachTags(env, perfs);
  await attachTracks(env, perfs);

  // 歌曲信息:已收录(attached,歌曲类)+ 待收录(pending 提案,挂在本行或草稿原条目)
  const probeIds = [...new Set(perfs.map((p) => p.id).concat(perfs.filter((p) => p.edit_target_id).map((p) => p.edit_target_id)))];
  let proposals = [];
  if (probeIds.length) {
    const CHUNK = 80;
    for (let i = 0; i < probeIds.length; i += CHUNK) {
      const chunk = probeIds.slice(i, i + CHUNK);
      const { results } = await env.DB.prepare(
        `SELECT t.name, t.performance_id, c.name AS category_name
         FROM tags t JOIN tag_categories c ON c.id = t.category_id
         WHERE t.status = 'pending' AND t.performance_id IN (${chunk.map(() => '?').join(',')})`
      ).bind(...chunk).all();
      if (results) proposals.push(...results);
    }
  }
  for (const p of perfs) {
    p.songs = (p.tags || []).filter((t) => t.category_name === SONG_CATEGORY).map((t) => t.name);
    const pendNames = proposals
      .filter((r) => r.category_name === SONG_CATEGORY && (r.performance_id === p.id || r.performance_id === p.edit_target_id))
      .map((r) => r.name);
    p.proposed_songs = [...new Set(pendNames)];
  }
  return json(perfs);
}

/** 作者删除自己的提交(任意状态含已审核)→ 软删进回收站(可恢复;逾期自动彻底清除)。
 *  与 admin 侧(src/review.js)软删共用 softDeletePerf。 */
async function handleDelete(request, env, user, id) {
  await checkRateLimit(env, 'subdel:' + user.id, 'submit_delete', 300, 5);
  const { results } = await env.DB.prepare(
    'SELECT id, user_id, is_deleted FROM performances WHERE id = ?').bind(id).all();
  const t = results[0];
  if (!t || Number(t.is_deleted)) throw new HttpError(404, '条目不存在');
  if (t.user_id !== user.id) throw new HttpError(403, '只能删除自己的条目');
  await softDeletePerf(env, id);
  return json({ ok: true });
}

/** 作者从回收站恢复自己的一条(原条级联其草稿)。仅本人 + 已在回收站。 */
async function handleRestoreOwn(request, env, user, id) {
  await checkRateLimit(env, 'subrst:' + user.id, 'submit_restore', 300, 10);
  const t = await trashOwnRow(env, user.id, id);
  await restorePerf(env, t.id);
  return json({ ok: true });
}

/** 作者从回收站彻底删除自己的一条(连同关联草稿/pending 提案)。仅本人 + 已在回收站。 */
async function handlePurgeOwn(request, env, user, id) {
  await checkRateLimit(env, 'subpurge:' + user.id, 'submit_purge', 300, 10);
  const t = await trashOwnRow(env, user.id, id);
  await purgePerf(env, t.id);
  return json({ ok: true });
}

/** 校验一条待操作的回收站条目属本人且确在回收站 */
async function trashOwnRow(env, userId, id) {
  const { results } = await env.DB.prepare(
    'SELECT id, user_id, is_deleted FROM performances WHERE id = ?').bind(id).all();
  const t = results[0];
  if (!t) throw new HttpError(404, '条目不存在');
  if (Number(t.is_deleted) !== 1) throw new HttpError(400, '条目不在回收站');
  if (t.user_id !== userId) throw new HttpError(403, '只能操作自己的条目');
  return t;
}
