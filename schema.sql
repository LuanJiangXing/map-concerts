-- 完整 schema(供参考 / 本地重建;生产由 Worker 冷启动 ensureSchema() 自动维护,无需手动执行)
-- 参考实现:src/db.js 的 ensureSchema()

CREATE TABLE IF NOT EXISTS performances (
  id TEXT PRIMARY KEY,
  singer TEXT NOT NULL DEFAULT 'david-tao',
  year INTEGER NOT NULL,
  date TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '其他',
  venue TEXT,
  city TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'approved',      -- pending / approved / rejected
  user_id TEXT DEFAULT '',                       -- 提交者
  edit_target_id TEXT,                           -- 草稿 → 原条目
  reject_reason TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  placeholder INTEGER NOT NULL DEFAULT 0,
  is_full INTEGER NOT NULL DEFAULT 0      -- 承载整场逐曲时间轴的链接(至多一条;v5)
);
CREATE INDEX IF NOT EXISTS idx_links_perf ON links(performance_id);

CREATE TABLE IF NOT EXISTS singers (
  id TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT,
  sort_order INTEGER DEFAULT 0,
  portrait TEXT,
  intro TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1                 -- 软删/停用(0=停用)
);

CREATE TABLE IF NOT EXISTS singer_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  portrait TEXT NOT NULL,                            -- 大头照 URL(外链)
  intro TEXT DEFAULT '',
  meta_intent TEXT NOT NULL DEFAULT 'provide' CHECK(meta_intent IN ('provide','want')),
  status TEXT NOT NULL DEFAULT 'pending',            -- pending / approved / rejected
  reject_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(user_id, name_zh)                           -- 同用户同中文名去重
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                   -- PBKDF2-SHA256(100k)+ 盐
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',             -- user / admin / banned
  display_name TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tag_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved',       -- approved / pending / rejected
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES tag_categories(id),
  status TEXT NOT NULL DEFAULT 'pending',        -- pending / approved / rejected
  created_by TEXT DEFAULT '',
  performance_id TEXT,                           -- 提案关联的演出(仅 pending 提案用)
  aliases TEXT DEFAULT '',                       -- 同标签其他写法,换行分隔(歌曲相似名防漏)
  singer_id TEXT DEFAULT '',                     -- 歌曲类别归属歌手(身份=(歌手,歌名);非歌曲类别恒 '')
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS performance_tags (
  performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (performance_id, tag_id)
);

-- 整场视频逐曲时间轴(2026-09-07,v5):按 performance_id 存(link 主键不稳定,不按 link_id 锚定);
-- 展示挂在 links.is_full=1 的整场链接下。name=提交者所填歌名;seconds NULL=唱过但没给时间。
-- part(v11)=bilibili 分 P(第几 P,缺省 1 单 P);seconds 语义 = 该曲在其 P 内起点秒(每 P 从 0 起)。
CREATE TABLE IF NOT EXISTS performance_tracks (
  performance_id TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  seconds INTEGER,
  part INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (performance_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tracks_perf ON performance_tracks(performance_id);

CREATE TABLE IF NOT EXISTS city_coords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT UNIQUE NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 审计:admin 对用户角色的变更(仿 geoguide audit_logs)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,               -- set_role_admin / set_role_user / set_role_banned / delete_user / change_username
  actor_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at, id);

-- 页面访问埋点(A 方案:只存 page + 可选登录用户,不落 IP/UA/referer)
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 大头照上传图(参考实现:src/db.js ensureSchema();Worker /uploads/{id} 回吐,见 src/uploads.js)
CREATE TABLE IF NOT EXISTS portrait_images (
  id TEXT PRIMARY KEY,               -- 'img-' + randomHex(8) → URL /uploads/img-…
  mime TEXT NOT NULL,                -- image/jpeg | image/webp | image/png | image/gif
  b64 TEXT NOT NULL,                 -- base64(无换行)
  user_id TEXT DEFAULT '',           -- 上传者
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created       ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_user_created  ON page_views(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tags_cat     ON tags(category_id);
CREATE INDEX IF NOT EXISTS idx_tags_status  ON tags(status);
CREATE INDEX IF NOT EXISTS idx_perf_tags_p  ON performance_tags(performance_id);
CREATE INDEX IF NOT EXISTS idx_perf_tags_t  ON performance_tags(tag_id);

CREATE INDEX IF NOT EXISTS idx_perf_status       ON performances(status);
CREATE INDEX IF NOT EXISTS idx_perf_user_status  ON performances(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_perf_edit_target  ON performances(edit_target_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_key_action   ON rate_limits(key, action, created_at);

-- 演出 reaction(v8,参考实现见 src/db.js ensureSchema)
CREATE TABLE IF NOT EXISTS reactions (
  performance_id TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  type           TEXT NOT NULL,
  created_at     TEXT,
  PRIMARY KEY (performance_id, user_id, type)
);
-- 演出贡献署名(v8)
CREATE TABLE IF NOT EXISTS performance_credits (
  performance_id TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  created_at     TEXT,
  PRIMARY KEY (performance_id, user_id)
);

-- 用户收藏(v9):登录用户收藏单场公开演出;(performance_id, user_id) 行唯一 → 幂等收藏
CREATE TABLE IF NOT EXISTS favorites (
  performance_id TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  created_at     TEXT,
  PRIMARY KEY (performance_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at);

-- 视频级封面/标题缓存(v10,参考实现见 src/db.js ensureSchema):以 (provider, video_id) 为键,
-- link 主键在草稿合并流整批替换不稳定,video 身份才稳定。写入 = /api/video-meta 成功即 UPSERT(写穿);
-- 读取 attachLinks 按 link.url 解析 (provider,video_id) 批量回填 cover_url。纯缓存,purge 演出不级联删。
CREATE TABLE IF NOT EXISTS video_meta (
  provider   TEXT NOT NULL,             -- 'youtube' | 'bilibili'
  video_id   TEXT NOT NULL,             -- YT: 11 位 / B站: BV|av…
  title      TEXT DEFAULT '',
  cover_url  TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, video_id)
);
