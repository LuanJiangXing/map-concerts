/* singer-request.js —— 请求新增歌手弹窗(首页"+"卡 / 提交页歌手选择器共用)
 * 数据:POST /api/singer-requests(登录+CSRF)。字段:name_zh/name_en/portrait/intro/meta_intent。
 * 校验对齐后端:中文/英文 ≤30、portrait(上传 /uploads 或 http(s)://)≤200、intro ≤200、意向二选一。
 * 409「已请求过该歌手」「该歌手已入驻」直接显示到表单。 */

(function () {
  'use strict';

  var overlay = null;
  var successCb = null;
  var submitting = false;
  var uploadedPortrait = null; // 已上传到本站的 /uploads/img-… 路径(供提交)

  function showErr(msg) {
    var err = overlay.querySelector('#sr-err');
    err.textContent = msg;
    err.hidden = false;
  }

  function build() {
    overlay = document.createElement('div');
    overlay.id = 'singer-request-modal';
    overlay.className = 'modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'singer-request-title');
    overlay.innerHTML =
      '<div class="modal-backdrop"></div>' +
      '<div class="modal-card">' +
        '<header class="modal-head">' +
          '<div>' +
            '<h2 id="singer-request-title">请求新增歌手</h2>' +
            '<p class="modal-meta">审核通过后即收录。</p>' +
          '</div>' +
          '<button id="singer-request-close" class="modal-close" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '</header>' +
        '<div class="modal-body">' +
          '<form id="singer-request-form" novalidate>' +
            '<div class="form-grid">' +
              '<label class="field"><span>中文名 *</span><input id="sr-name_zh" class="input" maxlength="30" required></label>' +
              '<label class="field"><span>英文名 *</span><input id="sr-name_en" class="input" maxlength="30" required></label>' +
              '<div class="field field--wide">' +
                '<span>大头照 *</span>' +
                '<div class="sr-portrait-row">' +
                  '<img id="sr-preview" class="portrait-preview sr-portrait-preview" alt="大头照预览" hidden>' +
                  '<input id="sr-portrait" class="input sr-portrait-input" maxlength="200" placeholder="粘贴图片直链 https://… 或点击右侧上传">' +
                  '<button type="button" class="ghost-icon-btn" id="sr-pick" title="从本地上传大头照" aria-label="从本地上传大头照"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>' +
                  '<input type="file" id="sr-portrait-file" accept="image/*" hidden>' +
                  '<button type="button" id="sr-pu-clear" class="ghost-icon-btn ghost-icon-btn--danger" title="移除图片" aria-label="移除图片" hidden><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
                '</div>' +
                '<span id="sr-pu-status" class="form-note" role="status"></span>' +
              '</div>' +
              '<label class="field field--wide"><span>简介(可选)</span><textarea id="sr-intro" class="input" rows="3" maxlength="200"></textarea></label>' +
            '</div>' +
            '<fieldset class="tags-editor">' +
              '<legend>意向 *</legend>' +
              '<div class="radio-row">' +
                '<label class="radio-item"><input type="radio" name="sr-intent" value="provide" required> 我能提供这个歌手的演出信息</label>' +
                '<label class="radio-item"><input type="radio" name="sr-intent" value="want"> 想看这个歌手的更多现场</label>' +
              '</div>' +
            '</fieldset>' +
            '<div class="form-actions">' +
              '<button type="submit" class="btn" id="sr-submit">提交请求</button>' +
              '<span id="sr-err" class="form-err" hidden></span>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#singer-request-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.classList.contains('modal-backdrop')) close();
    });
    overlay.querySelector('#singer-request-form').addEventListener('submit', submit);

    // 大头照上传:选图 → 压缩 → POST → 路径回填到 #sr-portrait(与手动 URL 同一输入)
    var fileInput = overlay.querySelector('#sr-portrait-file');
    var puStatus = overlay.querySelector('#sr-pu-status');
    var preview = overlay.querySelector('#sr-preview');
    var clearBtn = overlay.querySelector('#sr-pu-clear');
    function setPu(msg, isErr) {
      puStatus.textContent = msg || '';
      puStatus.style.color = isErr ? '#a8372d' : '';
    }
    overlay.querySelector('#sr-pick').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // 允许重复选同一文件
      if (!f) return;
      setPu('处理中…', false);
      PortraitUpload.toDataUrl(f).then(function (r) {
        return PortraitUpload.upload(r.data, r.mime).then(function (url) { return { r: r, url: url }; });
      }).then(function (res) {
        uploadedPortrait = res.url;
        overlay.querySelector('#sr-portrait').value = res.url;
        preview.src = res.r.dataUrl;
        preview.hidden = false;
        clearBtn.hidden = false;
        setPu('已托管到本站,预览即上传图。', false);
      }).catch(function (err) {
        setPu((err && err.message) ? err.message : '上传失败,请重试', true);
      });
    });
    var portraitInp = overlay.querySelector('#sr-portrait');
    portraitInp.addEventListener('input', function () {
      if (portraitInp.value.trim() || uploadedPortrait) {
        clearBtn.hidden = false;
      } else {
        clearBtn.hidden = true;
      }
    });
    clearBtn.addEventListener('click', function () {
      uploadedPortrait = null;
      portraitInp.value = '';
      preview.hidden = true;
      preview.removeAttribute('src');
      clearBtn.hidden = true;
      setPu('', false);
    });
  }

  /** 登录闸:未登录不开弹窗,直接跳登录页(/profile);已登录照常打开。
   *  放在唯一汇聚点 open() 而非各调用方,保证所有入口(首页"+"卡等)一致。 */
  function open(opts) {
    if (window.Auth) {
      Auth.me().then(function (u) {
        if (u) realOpen(opts);
        else location.href = '/profile';
      });
      return;
    }
    realOpen(opts);
  }

  function realOpen(opts) {
    if (!overlay) build();
    successCb = (opts && opts.onSuccess) ? opts.onSuccess : null;
    overlay.querySelector('#singer-request-form').reset();
    var err = overlay.querySelector('#sr-err');
    err.textContent = '';
    err.hidden = true;
    // 清上次的上传图状态(预览/状态/移除按钮 + 上传路径)
    uploadedPortrait = null;
    var _inp = overlay.querySelector('#sr-portrait');
    if (_inp) _inp.value = '';
    var _prev = overlay.querySelector('#sr-preview');
    if (_prev) { _prev.hidden = true; _prev.removeAttribute('src'); }
    var _clear = overlay.querySelector('#sr-pu-clear');
    if (_clear) _clear.hidden = true;
    var _st = overlay.querySelector('#sr-pu-status');
    if (_st) { _st.textContent = ''; _st.style.color = ''; }
    overlay.classList.add('open');
    document.body.classList.add('modal-open');
    var first = overlay.querySelector('#sr-name_zh');
    if (first) first.focus();
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.classList.remove('modal-open');
  }

  function submit(e) {
    e.preventDefault();
    if (submitting) return;
    var nameZh = overlay.querySelector('#sr-name_zh').value.trim();
    var nameEn = overlay.querySelector('#sr-name_en').value.trim();
    var portrait = overlay.querySelector('#sr-portrait').value.trim();
    var intro = overlay.querySelector('#sr-intro').value.trim();
    var intentEl = overlay.querySelector('input[name="sr-intent"]:checked');
    var intent = intentEl ? intentEl.value : '';

    if (!nameZh) return showErr('中文名必填');
    if (nameZh.length > 30) return showErr('中文名过长(≤30 字)');
    if (!nameEn) return showErr('英文名必填');
    if (nameEn.length > 30) return showErr('英文名过长(≤30 字)');
    if (!portrait) return showErr('请上传大头照,或填写图片链接');
    if (!/^https?:\/\//i.test(portrait) && !/^\/uploads\//.test(portrait)) {
      return showErr('大头照需为上传图(/uploads/…)或 http(s):// 链接');
    }
    if (portrait.length > 200) return showErr('大头照过长(≤200 字)');
    if (intro.length > 200) return showErr('简介过长(≤200 字)');
    if (!intent) return showErr('请选择意向');

    submitting = true;
    var btn = overlay.querySelector('#sr-submit');
    btn.disabled = true;
    Auth.request('POST', '/api/singer-requests', {
      name_zh: nameZh,
      name_en: nameEn,
      portrait: portrait,
      intro: intro,
      meta_intent: intent
    }).then(function (r) {
      submitting = false;
      btn.disabled = false;
      if (r.ok) {
        var cb = successCb;
        successCb = null;
        close();
        if (cb) cb();
        else if (window.AppDialog) AppDialog.toast('请求已提交，审核通过后即收录', { type: 'success', duration: 3500 });
        else alert('请求已提交,审核通过后即收录。');
      } else {
        showErr(r.data.error || '提交失败,请重试');
      }
    }).catch(function () {
      submitting = false;
      btn.disabled = false;
      showErr('网络错误,请重试');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('open')) close();
    });
  });

  window.SingerRequest = { open: open, close: close };
})();
