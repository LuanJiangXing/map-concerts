/* gen-seed.js —— 从 data/performances.js 生成 seed.sql(一次性迁移工具) */
const fs = require('fs');
const src = fs.readFileSync('data/performances.js', 'utf8');
global.window = {};
eval(src); // 设置 window.PERFORMANCES
const rows = window.PERFORMANCES;

const q = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

let sql = '-- 种子数据:由 data/performances.js 迁移(占位,待真实数据替换)\n';
sql += 'INSERT INTO performances (id, singer, year, date, title, type, venue, city, lat, lng, verified, note) VALUES\n';
sql += rows.map((r) =>
  `  (${q(r.id)}, ${q(r.singer)}, ${r.year}, ${q(r.date || '')}, ${q(r.title)}, ${q(r.type || '其他')}, ${q(r.venue || '')}, ${q(r.city)}, ${r.lat}, ${r.lng}, ${r.verified ? 1 : 0}, ${q(r.note || '')})`
).join(',\n') + ';\n';

const linkRows = [];
rows.forEach((r) => (r.links || []).forEach((l) =>
  linkRows.push(`  (${q(r.id)}, ${q(l.label)}, ${q(l.url)}, ${l.placeholder ? 1 : 0})`)));
sql += '\nINSERT INTO links (performance_id, label, url, placeholder) VALUES\n' + linkRows.join(',\n') + ';\n';

fs.writeFileSync('seed.sql', sql);
console.log('seed.sql 生成:', rows.length, '条演出,', linkRows.length, '条链接');
