/* portrait-upload.js —— 大头照本地上传共享组件(申请歌手弹窗 / 后台歌手编辑共用)
 *
 * 选本地图 → canvas 等比压缩(有透明转 WebP,否则 JPEG,白底)→ base64 → JSON
 * POST /api/uploads/portrait(登录+CSRF 由 Auth.request 带)→ { url:"/uploads/img-…" }。
 * 无 DOM 依赖,只暴露两个纯函数,便于两处接入:
 *   PortraitUpload.toDataUrl(file) → Promise<{ mime, data, dataUrl }>(失败 reject 中文 Error)
 *   PortraitUpload.upload(data, mime) → Promise<url 站内路径>
 * 压缩目标:长边 ≤ MAX_EDGE、base64 ≤ MAX_B64(留余量给后端 280KB 上限)。
 */

(function () {
  'use strict';

  var MAX_EDGE = 512;
  var QUALITY = 0.86;
  var MAX_B64 = 260 * 1024; // 解码后 ≤280KB 的后端上限;此处压到 base64 ≤260KB 更保险
  var MIN_DIM = 24;         // 过小图(疑似图标/像素垃圾)直接拒
  var ATTEMPTS = [          // [长边, 质量] 逐档降,仍超则拒
    [512, 0.86],
    [384, 0.80],
    [256, 0.72]
  ];
  var SUPPORT_WEBP = (function () {
    try { return document.createElement('canvas').toDataURL('image/webp', 0.5).indexOf('image/webp') === 0; }
    catch (e) { return false; }
  })();

  function readImage(file) {
    // 用 FileReader 读成 data: URL 交给 <img> 解码——站点 CSP 只放行 img-src 'self' data: https:,
    // 用 blob: URL 会被拦截导致 onerror(见 portrait 上传调试验证)。原图再大也只是临时解码。
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('无法读取该图片,仅支持图片文件')); };
        img.src = fr.result;
      };
      fr.onerror = function () { reject(new Error('无法读取该图片,仅支持图片文件')); };
      fr.readAsDataURL(file);
    });
  }

  /** 抽小样判断是否有可见透明(4 角 + 中心);真透明才走 WebP/PNG,否则 JPEG 白底更小 */
  function hasAlpha(img) {
    var s = Math.min(1, 48 / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    try {
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    } catch (e) { return false; }
    return false;
  }

  /** 等比缩到长边=edge、渲染到 canvas,返回 data URL(JPEG 铺白底防黑背景) */
  function toDataUrlAt(img, edge, mime, q) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.min(1, edge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); }
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL(mime, q);
  }

  function b64Len(dataUrl) {
    var i = dataUrl.indexOf(',');
    return dataUrl.length - i - 1;
  }

  /** 主入口:file → 压缩 base64;超限逐档降,仍超 → reject */
  function toDataUrl(file) {
    return readImage(file).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h || w < MIN_DIM || h < MIN_DIM) return Promise.reject(new Error('图片过小或不是有效图片'));
      var alpha = hasAlpha(img);
      var mime = alpha ? (SUPPORT_WEBP ? 'image/webp' : 'image/png') : 'image/jpeg';

      var dataUrl = null;
      for (var i = 0; i < ATTEMPTS.length; i++) {
        dataUrl = toDataUrlAt(img, ATTEMPTS[i][0], mime, ATTEMPTS[i][1]);
        if (b64Len(dataUrl) <= MAX_B64) break;
        dataUrl = null;
      }
      if (!dataUrl) return Promise.reject(new Error('图片太大,压缩后仍超限,请换一张更小的'));
      return {
        mime: mime,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        dataUrl: dataUrl
      };
    });
  }

  /** 上传(base64 JSON)→ 站内路径;依赖 window.Auth(request 已带 CSRF) */
  function upload(data, mime) {
    if (!window.Auth) return Promise.reject(new Error('请先登录后再上传'));
    return Auth.request('POST', '/api/uploads/portrait', { data: data, mime: mime }).then(function (r) {
      if (!r.ok) throw new Error((r.data && r.data.error) || '上传失败,请重试');
      return r.data.url;
    });
  }

  window.PortraitUpload = { toDataUrl: toDataUrl, upload: upload };
})();
