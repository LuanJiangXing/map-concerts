/* src/uploads.js —— 大头照上传图:上传端点 + 读取服务
 *
 * POST /api/uploads/portrait(登录+CSRF+限流):
 *   客户端 canvas 压缩 → { data: <base64 无前缀>, mime } JSON → 校验 → 落 D1 portrait_images
 *   → 201 { ok, url: "/uploads/img-<hex>" }。
 * GET /uploads/{id}(无需登录,幂等只读):
 *   查行回吐原 bytes + 原 mime + immutable 长缓存。id 随机一次一写 → 替换大头照 = 新 key,
 *   旧 key 不再被引用(孤儿,保留防陈旧引用 404)。
 * portrait 列语义不变(仍是 URL 字符串):外链 https 或站内 /uploads/img-… 都兼容现有显示管线。
 *
 * 安全:服务端无图像库 → 以「白名单 mime + base64 合法性 + 魔数嗅探 + 尺寸上下限」为闸;
 * 大小闸由前端压缩(≤~260KB base64)兜底、此处权威复核。非图片/超限一律 400,不落库。
 */
import { json, readBody, requireUser, csrfCheck, checkRateLimit, randomHex, HttpError } from './db.js';

const MIME_ALLOW = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };
const MAX_BYTES = 280 * 1024;   // 解码后上限(前端压到 ~260KB,留余量)
const MIN_BYTES = 50;           // 空/极小文件拒绝
const ID_PREFIX = 'img-';
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64Map = new Uint8Array(128).fill(255);
for (let i = 0; i < B64_CHARS.length; i++) b64Map[B64_CHARS.charCodeAt(i)] = i;

/** 手写 base64 解码(不去依赖 atob 的存在性);非法字符/长度 → throw。入参已去空白。 */
function b64ToBytes(s) {
  if (!s || s.length % 4 === 1) throw new Error('bad b64');
  const out = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61 /* '=' */) break; // 允许省略/中途截断,后续魔数校验把关
    const v = c < 128 ? b64Map[c] : 255;
    if (v === 255) throw new Error('bad b64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return Uint8Array.from(out);
}

function bytesAscii(bytes, from, to) {
  let s = '';
  for (let i = from; i < to && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** 魔数嗅探:声明 mime 必须匹配真实文件头(JPEG/PNG/WebP/GIF),防任意 base64 当图存 */
function magicOk(bytes, mime) {
  if (bytes.length < 12) return false;
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === 'image/webp') return bytesAscii(bytes, 0, 4) === 'RIFF' && bytesAscii(bytes, 8, 12) === 'WEBP';
  if (mime === 'image/gif') {
    const head = bytesAscii(bytes, 0, 6);
    return head === 'GIF87a' || head === 'GIF89a';
  }
  return false;
}

/* ---------- POST /api/uploads/portrait ---------- */
export async function handlePortraitUpload(request, env) {
  const user = await requireUser(request, env); // 登录即可:申请方与后台 admin 共用同一端点
  csrfCheck(request);
  await checkRateLimit(env, 'pup:' + user.id, 'portrait_upload', 3600, 10);
  await checkRateLimit(env, 'pup:' + user.id, 'portrait_upload_day', 86400, 30);

  const body = await readBody(request, 400 * 1024); // base64 JSON 上限(权威在字节复核)
  const mime = String(body.mime || '');
  const data = String(body.data || '').replace(/\s+/g, '');
  if (!MIME_ALLOW[mime]) throw new HttpError(400, '仅支持 jpg/png/webp/gif 图片');

  let bytes;
  try { bytes = b64ToBytes(data); } catch { throw new HttpError(400, '图片数据无效'); }
  if (bytes.length < MIN_BYTES) throw new HttpError(400, '图片过小或为空');
  if (bytes.length > MAX_BYTES) throw new HttpError(400, '图片过大(≤280KB)');
  if (!magicOk(bytes, mime)) throw new HttpError(400, '仅支持 jpg/png/webp/gif 图片');

  const id = ID_PREFIX + randomHex(8);
  await env.DB.prepare('INSERT INTO portrait_images (id, mime, b64, user_id) VALUES (?,?,?,?)')
    .bind(id, mime, data, user.id).run();
  return json({ ok: true, url: '/uploads/' + id }, 201);
}

/* ---------- GET /uploads/{id} ---------- */
export async function servePortraitImage(request, env, id) {
  if (!/^[a-z0-9-]+$/.test(id)) return new Response('not found', { status: 404 });
  const row = await env.DB.prepare('SELECT mime, b64 FROM portrait_images WHERE id = ?').bind(id).first();
  if (!row) return new Response('not found', { status: 404 });
  let bytes;
  try { bytes = b64ToBytes(String(row.b64 || '')); } catch { return new Response('bad image', { status: 500 }); }
  return new Response(bytes, {
    headers: {
      'content-type': row.mime,
      // id 随机一次一写、内容永不变 → immutable 长缓存;替换 = 新 key,无陈旧窗口
      'cache-control': 'public, max-age=31536000, immutable',
      'etag': '"' + id + '"',
    },
  });
}
