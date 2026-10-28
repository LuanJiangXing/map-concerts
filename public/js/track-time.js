/* track-time.js —— 整场视频逐曲时间轴的小工具(2026-09-07)
 * 与 src/submissions.js 的 parseStartTime/isBilibiliUrl 语义对齐(服务端仍为权威)。
 * 只在两个页面用:submit.html(提交表单校验/收集)、singer.html(modal 弹窗展示)。
 */
(function () {
  'use strict';

  var MAX_SECONDS = 12 * 3600; // 12h,bilibili 整场录像足够

  /** 解析开始时间(m:ss / h:mm:ss,容忍全角冒号)。空 → {sec:null};非法 → {err:true}。 */
  function parse(text) {
    var s = String(text == null ? '' : text).trim().replace(/：/g, ':');
    if (!s) return { sec: null, err: false };
    var parts = s.split(':');
    if (parts.length < 2 || parts.length > 3) return { err: true };
    var seg = parts.map(function (x) { return /^\d{1,3}$/.test(x) ? Number(x) : NaN; });
    for (var i = 0; i < seg.length; i++) if (Number.isNaN(seg[i])) return { err: true };
    var sec;
    if (parts.length === 2) {
      if (seg[1] > 59) return { err: true };
      sec = seg[0] * 60 + seg[1];
    } else {
      if (seg[1] > 59 || seg[2] > 59) return { err: true };
      sec = seg[0] * 3600 + seg[1] * 60 + seg[2];
    }
    if (sec > MAX_SECONDS) return { err: true };
    return { sec: sec, err: false };
  }

  /** 秒 → '04:00' / '1:02:03';null → '' */
  function format(sec) {
    if (sec == null) return '';
    var total = Math.floor(sec);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  /** 是否 bilibili 视频链接(整场逐曲时间轴 MVP 只支持它) */
  function isBilibili(url) {
    try {
      var h = new URL(String(url || '').trim()).hostname.toLowerCase();
      return h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv' || h.endsWith('.b23.tv');
    } catch (e) { return false; }
  }

  /** 剥歌名尾部单个括号备注块:「…」/(…)/（…）,只剥最后一块,保护歌名中段括号 */
  /** 剥歌名尾部括号备注块:「…」/(…)/（…）/【…】/[…] (循环剥除多层,保护歌名中段括号) */
  function stripTailNote(name) {
    var s = String(name == null ? '' : name).trim();
    while (true) {
      var last = s.slice(-1);
      var prev = s;
      if (last === '」') { var i = s.lastIndexOf('「'); if (i >= 0 && i < s.length - 1) s = s.slice(0, i).trim(); }
      else if (last === '）') { var j = s.lastIndexOf('（'); if (j >= 0 && j < s.length - 1) s = s.slice(0, j).trim(); }
      else if (last === ')') { var k = s.lastIndexOf('('); if (k >= 0 && k < s.length - 1) s = s.slice(0, k).trim(); }
      else if (last === '】') { var l = s.lastIndexOf('【'); if (l >= 0 && l < s.length - 1) s = s.slice(0, l).trim(); }
      else if (last === ']') { var m = s.lastIndexOf('['); if (m >= 0 && m < s.length - 1) s = s.slice(0, m).trim(); }
      if (s === prev || !s) break;
    }
    return s || String(name || '').trim();
  }

  /** 清洗单个歌名中的前导前缀/序号/时间戳、尾部歌手/修饰词/备注(保留歌名内部合法冒号如 飞机场的10:30) */
  function cleanSongName(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/：/g, ':');
    if (!s) return '';

    // 1. 剥常见业务/演出环节前缀: 城市限定曲：, 点歌环节：, 安可曲：, 返场：, 首唱：
    s = s.replace(/^(?:城市限定(?:曲)?|限定曲|返场(?:曲)?|安可(?:曲)?|首唱(?:曲)?|点歌(?:环节)?|加更)[：:]\s*/i, '');

    // 2. 剥除前导外层括号包裹的时间或序号: 如 [00:00]、(01:23:45)、【01】、(1)
    s = s.replace(/^(?:\[|【|\()\s*(?:\d{1,3}:[0-5]\d(?::[0-5]\d)?|\d{1,3})\s*(?:\]|】|\))\s*/, '');

    // 3. 剥除前导序号(须在剥时间前,防 01. 00:00 找自己;点后不能跟数字防把 6.28 误当序号): 如 01. 找自己、1、找自己、01 找自己
    s = s.replace(/^\d{1,3}(?:\.(?!\d)|、)\s*/, '');
    s = s.replace(/^0\d{1,2}\s+/, '');

    // 4. 剥除前导时间戳(m:ss / h:mm:ss): 如 0:00:01 找自己、0:02:50浮游、02:50 找自己 (含二次括号包裹)
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

    // 9. 剥除行尾时间戳: 如 找自己 05:00、找自己 (05:00)、找自己 [01:20:30]
    s = s.replace(/(?:\s+|\s*(?:\[|【|\()\s*)\d{1,3}:[0-5]\d(?::[0-5]\d)?\s*(?:\]|】|\))?\s*$/, '');

    // 10. 剥除前导独立加号/延续符: 如 ＋自己按门铃自己听 → 自己按门铃自己听
    s = s.replace(/^[+＋\s]+/, '');

    // 11. 剥除尾部各类括号备注: 「…」/(…)/（…）/【…】/[…] (循环剥除多层)
    return stripTailNote(s);
  }

  /** 将可能为组曲/串烧的歌名切分为单曲数组:
   *  - 识别前导组曲前缀(如 "邓丽君组曲:", "经典串烧：")并剥除
   *  - 若包含 + 或 ＋,则按加号切分为多首子歌名并逐一 cleanSongName 清洗去重
   *  - 不包含加号则直接返回 [cleanSongName(raw)] (若为空则返回 [])
   */
  function splitMedleySongs(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return [];
    s = s.replace(/^(?:.*?(?:组曲|串烧|联唱|合辑))[：:]\s*/i, '');
    if (!/[+＋]/.test(s)) {
      var c = cleanSongName(s);
      return c ? [c] : [];
    }
    var parts = s.split(/[+＋]/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var sub = cleanSongName(parts[i]);
      if (sub && out.indexOf(sub) === -1) out.push(sub);
    }
    return out;
  }

  /** 将一段歌曲文本拆成歌名数组:自动合并以+或＋开头的跨行组曲、过滤独立段行(pN)、按顿号/换行切分、逐首清洗 */
  function splitSongList(text) {
    var rawLines = String(text || '').split('\n');
    var mergedLines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i].trim();
      if (!line) continue;
      // 过滤独立 bilibili 段行 pN (如 p1 / P2)
      if (normSeg(line).match(/^p\s*(\d{1,3})\s*$/i)) continue;
      if (/^[+＋]/.test(line) && mergedLines.length > 0) {
        mergedLines[mergedLines.length - 1] += line;
      } else {
        mergedLines.push(line);
      }
    }
    var out = [];
    for (var j = 0; j < mergedLines.length; j++) {
      var parts = mergedLines[j].split('、');
      for (var k = 0; k < parts.length; k++) {
        var c = cleanSongName(parts[k]);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** 段行归一:全角 P/全角数字/全角空白 → 半角(仅用于识别独立 pN 段行,不动歌名原文) */
  function normSeg(s) {
    return String(s)
      .replace(/[Ｐｐ]/g, 'p')
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[　]+/g, ' ')
      .trim();
  }

  /** 整段歌单文本 → { rows:[{name,seconds,part}], ignored:[原文行] }。
   *  每行两种格式混排:行首时间(m:ss | h:mm:ss,容忍全角冒号)+ 歌名,或
   *  歌名在前 + 至少一个空白 + 行尾时间(m:ss | h:mm:ss);行尾单个「」/()备注剥掉;
   *  独立段行 `pN`(大小写/全角/空白容忍,1–999)→ 切当前 P,后续时间行(行首/行尾时间)归该 P;段行不计入歌曲行。
   *  `pN` 前缀 + 时间在中段的歧义行(如 `p2 05:00 歌名`)不算段行、也不作行尾时间 → 照旧按非时间行进 ignored。
   *  无法按 时间+歌名 / 歌名+时间 解析的非空行进 ignored(不导入);空行跳过。 */
  function parseList(text) {
    var rows = [];
    var ignored = [];
    var currentPart = 1;
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].replace(/：/g, ':').trim();
      if (!raw) continue;
      // 独立段行 pN(bilibili 分 P 切换;缺省 p1)
      var seg = normSeg(raw).match(/^p\s*(\d{1,3})\s*$/i);
      if (seg) {
        var pnum = Number(seg[1]);
        if (pnum >= 1 && pnum <= 999) currentPart = pnum;
        else ignored.push(raw);
        continue;
      }
      // 跨行组曲延续行:本行以 + 或 ＋ 开头且前面已有解析出的曲目行 → 追加至上一行歌名
      if (/^[+＋]/.test(raw) && rows.length > 0) {
        rows[rows.length - 1].name = cleanSongName(rows[rows.length - 1].name + raw);
        continue;
      }
      // 容忍行首包裹的时间或序号，如 【00:00】找自己 -> 00:00 找自己，01. 00:00 找自己 -> 00:00 找自己
      var normalizedLine = raw
        .replace(/^(?:\[|【|\()\s*(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\s*(?:\]|】|\))\s*/, '$1 ')
        .replace(/^\d{1,3}[\.、]\s*/, '');

      var m3 = normalizedLine.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)\s*(.*)$/);
      var sec, rest;
      if (m3) {
        sec = Number(m3[1]) * 3600 + Number(m3[2]) * 60 + Number(m3[3]);
        rest = m3[4];
      } else {
        // 分钟可三位数(100+ 分钟整场),仍受下方 MAX_SECONDS=12h 兜底;与 parse() 语义一致
        var m2 = normalizedLine.match(/^(\d{1,3}):([0-5]\d)\s*(.*)$/);
        if (!m2) {
          // 歌名在前、时间在行尾(m:ss | h:mm:ss,容忍全角冒号已由行级 ：→: 归一):
          // 歌名与时间间须至少一个空白([ \t　]+),时间须为行尾(容许尾随空白);秒两位 00–59。
          // 贪心 `.*\S` 保歌名尾字符非空白、不吞空白与时间;剥尾注后仍非空才入 rows。
          // 时间在中段的歧义行(如 `p2 05:00 歌名`)不会匹配 → 落到下方 ignored(不扩)。
          var tt = normalizedLine.match(/^(.*\S)[ \t　]+(\d{1,3}):([0-5]\d)(?::([0-5]\d))?[ \t　]*$/);
          if (!tt) { ignored.push(raw); continue; }
          var tsec = tt[4] != null
            ? Number(tt[2]) * 3600 + Number(tt[3]) * 60 + Number(tt[4])
            : Number(tt[2]) * 60 + Number(tt[3]);
          if (tsec > MAX_SECONDS) { ignored.push(raw); continue; }
          var tname = cleanSongName(tt[1]);
          if (!tname) { ignored.push(raw); continue; }
          rows.push({ name: tname, seconds: tsec, part: currentPart });
          continue;
        }
        sec = Number(m2[1]) * 60 + Number(m2[2]);
        rest = m2[3];
      }
      if (sec > MAX_SECONDS) { ignored.push(raw); continue; }
      var name = cleanSongName(rest);
      if (!name) { ignored.push(raw); continue; }
      rows.push({ name: name, seconds: sec, part: currentPart });
    }
    return { rows: rows, ignored: ignored };
  }

  /** 基础链接拼上起始秒与分 P(bilibili:`?p=N&t=<纯秒>`;part≤1/缺省不带 p,与旧行为一致)。 */
  function jumpUrl(base, sec, part) {
    try {
      var u = new URL(String(base || '').trim());
      u.searchParams.set('t', String(Math.floor(sec)));
      var p = Number(part);
      if (Number.isInteger(p) && p > 1) u.searchParams.set('p', String(p));
      return u.toString();
    } catch (e) { return String(base || ''); }
  }

  window.TrackTime = {
    parse: parse,
    format: format,
    isBilibili: isBilibili,
    jumpUrl: jumpUrl,
    parseList: parseList,
    cleanSongName: cleanSongName,
    splitSongList: splitSongList,
    splitMedleySongs: splitMedleySongs
  };
})();
