/* map.js —— 内联 SVG 世界地图 + 城市点位 + 缩放平移
 *
 * 照抄 geoguide 首页世界地图(world-map.js)的实现:
 *   - fetch world.svg 文本 → 注入为内联 SVG(矢量,任意缩放清晰,国界靠 CSS 描边)
 *   - 有数据的国家着色(has-data),其余中性
 *   - 缩放按钮 +/-、滚轮缩放(锚定鼠标)、拖动平移(**viewBox 窗口**,不是 CSS transform)
 *   - 城市点位为 SVG 圆点,点击弹演出弹窗;悬浮显示 城市·场次
 *   - 近邻城市(深圳/香港等,屏幕距离小于两半径和)在当前缩放下重叠 →
 *     点击弹出「邻近城市」选择器(城市·场次),选中再开弹窗;孤点行为不变
 *   - 聚合点(zoom-out 拥挤治理):两可见点**圆盘相交(圆心距 < 半径和)**的城市画成一个带
 *     城市数的聚合点;点它弹成员列表(≤ CLUSTER_PICK_MAX 城),超阈值的簇不可点。见下常量注释。
 *
 * 投影与 geoguide 一致:经度 → x 严格线性;纬度 → 单调样条 0.25° 查表。
 */

(function () {
  'use strict';

  var VIEW_W = 1010;          // world.svg viewBox 宽
  var VIEW_H = 666;           // world.svg viewBox 高
  // 地图 .map 的 CSS max-width 为 900(style.css)。点位尺寸按此「桌面满窗」参照宽折算成
  // 恒定屏幕 px(K_REF),窄地图(手机)不再随 host 宽等比缩小——否则手机端单城点缩到 ~1px、
  // 聚合点却保持原样,单点过小/聚合过大比例失衡(2026-09-08 修)。
  var MAP_W_REF = 900;
  var K_REF = MAP_W_REF / VIEW_W; // ≈0.891:城市点恒定屏幕半径 = dotRadiusFor(count)·K_REF

  // 初始视角缩放上限:可见经度 ≥ 此值(2026-09-07 从 72° 拉大到 100°,初始更远一些;
  // 仍远小于世界≈360°),与地理位置无关。
  // 数据挤在一小簇 → 初始最多放大到这(不深钻);数据本身更广 → 自动再放大到包住数据,最大世界。
  var AUTO_FIT_MIN_LON_DEG = 100;

  var ZOOM_MIN = 1, ZOOM_MAX = 16; // 最大 16×,与 geoguide 同款底图拉齐(其验证过的干净天花板)
  // 城市点基准屏幕半径(px),随场次数增大(面积感 ∝ 场次,sqrt)。放大按 1/s 反缩,屏幕尺寸恒定。
  // 公式 r(count) = min(DOT_R_MIN + DOT_K*sqrt(count), DOT_R_MAX)
  var DOT_R_MIN = 3.5, DOT_K = 2.1, DOT_R_MAX = 13;
  var DOT_STROKE = 1.5;       // 城市点描边宽度,随 1/s 反缩

  // 城市点聚合(zoom-out 拥挤治理):任两可见点**圆盘相交(圆心距 < 半径和)**即聚合(传递相连),
  // 圆心取成员平均、外加大标数字显示成员城数。聚合把**点的尺寸**计入判定 —— 场次多的城市圆大
  // (如广州 3 场 → 圆 ~6.4px),和邻城(深圳,圆 ~3.1px)即使圆心距 > 旧固定 8px、只要两圆重叠
  // 就收进同一徽章(2026-09-08:原 CLUSTER_SEP=8 只按圆心距,广州圆大与深圳重叠却不聚)。
  //  - 可见点画在徽章**之上**、命中**先点后徽章**(见 updateClusters/pointerUp/pointermove):
  //    被拆出的近邻点即使圆心落在徽章圆盘内也可见可点,不被徽章盖住或抢走点击。
  //  - CLUSTER_PICK_MAX:聚合点内城市数 ≤ 此 → 点击弹成员「邻近城市」列表;> 此 → **不可点**
  //    (不开列表,也不放大),徽章同时淡化,视觉与行为一致。
  //    2026-09-15 设定:点聚合点永不放大(放大交给滚轮/双指/±按钮);阈值定为 20 让「十几城」
  //    能直接开列表;超过 20 城的超大簇列表过长,故不可点。
  var CLUSTER_PICK_MAX = 20;
  var CLUSTER_FS = 11;        // 聚合点内数字字号(px,随 1/s 反缩,屏幕恒定)

  // 悬浮黑卡让位(2026-09-15):黑卡必须整体落在**当前悬停目标的命中圆之外**。
  // 见 placeTip 注释 —— 偏移量取「命中半径 + TIP_CLEAR_GAP」,不再用固定 12px。
  var TIP_CLEAR_GAP = 6;      // 黑卡与命中圆之间的最小间隙(px)
  var TIP_MARGIN = 6;         // 黑卡距地图边缘的最小留白(px)

  // 「邻近城市」选择器尺寸自适应(2026-09-15):成员多的簇列表会长过地图高度。
  var PICKER_MARGIN = 8;      // 选择器距地图边缘的最小留白(px)
  var PICKER_FS_MIN = 11;     // 选择器缩字号下限(px)。2026-09-16:基准字号降到 --fs-xs(12) 后
                              // 下限随之下移一档 ——「已经缩小的那些」也要更小(用户要求)。
                              // 这是**浮层内的局部兜底**,不新增阶梯档;只在列表放不下时才走到。

  /** 解析主题强调色(兜底 #b45f0a),供聚合点内联 fill:不依赖 style.css 是否已带
   *  .city-clusters 规则(该规则本提交才新增,旧 CSS 缓存期间 circle 会继承底图
   *  米灰 #d8cfbd → 灰圆)。CSS 加载后同值覆盖,无副作用。 */
  /** 读计算样式里的主题令牌(带兜底)。S4d:聚合点配色不再写死白/米色字面量 ——
   *  dark 下 --accent-2 #f0863a 上的白字仅 ~2.6:1,改用 --on-accent(深墨,≈7.1:1);
   *  描边用 --dot-stroke(随主题:dark 近黑 / light 近白)。CSS 规则仍同值覆盖,此处兜底。 */
  function themeVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (v) return v;
    } catch (e) { /* ignore */ }
    return fallback;
  }
  function accentColor() {
    return themeVar('--accent-2', '#b45f0a');
  }

  function dotRadiusFor(count) {
    return Math.min(DOT_R_MIN + DOT_K * Math.sqrt(Math.max(1, Number(count) || 1)), DOT_R_MAX);
  }

  var LON = { a: 2.811304, b: 474.801355 };

  // 纬度 → y 参考点表 [lat, y](经验拟合,同 geoguide)
  // 2026-09-06:修正 18.25–20.5°N 段。原表该段压平在 ~411(近 20°N 才陡降),
  // 与 world.svg 实际绘制的海南岛不符 → 海口(20.04°N)点偏到岛南岸外。
  // 现按岛岸实测重拟合:岛北岸(海口侧,lon~110.2)y≈406,南岸(三亚侧)y≈411.5,单调接续两端。
  var LAT_Y = [
    [-41.00,600.8],[-40.75,600.0],[-40.50,598.8],[-40.25,597.5],[-40.00,596.2],[-39.75,
    594.9],[-39.50,593.6],[-39.25,592.3],[-39.00,591.0],[-38.75,589.7],[-38.50,588.4],
    [-38.25,587.0],[-38.00,585.7],[-37.75,584.4],[-37.50,583.1],[-37.25,581.8],[-37.00,
    580.5],[-36.75,579.1],[-36.50,577.8],[-36.25,576.6],[-36.00,575.3],[-35.75,574.0],
    [-35.50,572.7],[-35.25,571.5],[-35.00,570.3],[-34.75,569.0],[-34.50,567.8],[-34.25,
    566.7],[-34.00,565.5],[-33.75,564.3],[-33.50,563.2],[-33.25,562.1],[-33.00,561.0],
    [-32.75,560.0],[-32.50,558.9],[-32.25,557.9],[-32.00,557.0],[-31.75,556.0],[-31.50,
    555.1],[-31.25,554.2],[-31.00,553.3],[-30.75,552.4],[-30.50,551.5],[-30.25,550.7],
    [-30.00,549.9],[-29.75,549.1],[-29.50,548.3],[-29.25,547.5],[-29.00,546.7],[-28.75,
    546.0],[-28.50,545.2],[-28.25,544.5],[-28.00,543.7],[-27.75,542.9],[-27.50,542.2],
    [-27.25,541.5],[-27.00,540.8],[-26.75,540.1],[-26.50,539.4],[-26.25,538.7],[-26.00,
    538.0],[-25.75,537.3],[-25.50,536.5],[-25.25,535.8],[-25.00,535.1],[-24.75,534.4],
    [-24.50,533.6],[-24.25,532.9],[-24.00,532.1],[-23.75,531.3],[-23.50,530.6],[-23.25,
    529.8],[-23.00,529.0],[-22.75,528.2],[-22.50,527.3],[-22.25,526.5],[-22.00,525.7],
    [-21.75,524.9],[-21.50,524.1],[-21.25,523.3],[-21.00,522.6],[-20.75,521.8],[-20.50,
    521.0],[-20.25,520.3],[-20.00,519.6],[-19.75,518.9],[-19.50,518.2],[-19.25,517.6],
    [-19.00,517.0],[-18.75,516.7],[-18.50,515.6],[-18.25,514.2],[-18.00,512.8],[-17.75,
    511.6],[-17.50,510.9],[-17.25,510.5],[-17.00,510.2],[-16.75,510.0],[-16.50,509.8],
    [-16.25,509.3],[-16.00,508.7],[-15.75,508.0],[-15.50,507.3],[-15.25,506.6],[-15.00,
    505.8],[-14.75,505.1],[-14.50,504.2],[-14.25,503.4],[-14.00,502.6],[-13.75,501.9],
    [-13.50,501.1],[-13.25,500.3],[-13.00,499.6],[-12.75,499.0],[-12.50,498.3],[-12.25,
    497.6],[-12.00,497.0],[-11.75,496.3],[-11.50,495.7],[-11.25,495.1],[-11.00,494.4],
    [-10.75,493.7],[-10.50,493.1],[-10.25,492.4],[-10.00,491.6],[-9.75,490.8],[-9.50,
    490.0],[-9.25,489.2],[-9.00,488.2],[-8.75,487.2],[-8.50,486.4],[-8.25,485.5],[-8.00,
    484.7],[-7.75,483.9],[-7.50,483.1],[-7.25,482.4],[-7.00,481.6],[-6.75,480.9],[-6.50,
    480.2],[-6.25,479.5],[-6.00,478.8],[-5.75,478.1],[-5.50,477.5],[-5.25,476.8],[-5.00,
    476.1],[-4.75,475.5],[-4.50,474.8],[-4.25,474.2],[-4.00,473.6],[-3.75,472.9],[-3.50,
    472.3],[-3.25,471.6],[-3.00,471.0],[-2.75,470.3],[-2.50,469.6],[-2.25,469.0],[-2.00,
    468.3],[-1.75,467.6],[-1.50,466.9],[-1.25,466.3],[-1.00,465.6],[-0.75,465.0],[-0.50,
    464.3],[-0.25,463.7],[0.00,463.0],[0.25,462.3],[0.50,461.6],[0.75,460.9],[1.00,460.2],
    [1.25,459.4],[1.50,458.6],[1.75,457.7],[2.00,456.6],[2.25,455.6],[2.50,454.5],[2.75,
    453.6],[3.00,452.9],[3.25,452.4],[3.50,452.2],[3.75,452.1],[4.00,451.9],[4.25,451.1],
    [4.50,450.3],[4.75,449.6],[5.00,448.9],[5.25,448.2],[5.50,447.5],[5.75,446.7],[6.00,
    446.0],[6.25,445.3],[6.50,444.6],[6.75,443.9],[7.00,443.2],[7.25,442.5],[7.50,441.9],
    [7.75,441.2],[8.00,440.5],[8.25,440.0],[8.50,439.5],[8.75,438.9],[9.00,438.4],[9.25,
    437.9],[9.50,437.3],[9.75,436.6],[10.00,435.7],[10.25,434.3],[10.50,433.0],[10.75,
    432.1],[11.00,431.3],[11.25,430.7],[11.50,430.1],[11.75,429.6],[12.00,429.1],[12.25,
    428.5],[12.50,427.8],[12.75,427.1],[13.00,426.3],[13.25,425.6],[13.50,424.9],[13.75,
    424.2],[14.00,423.6],[14.25,423.1],[14.50,422.6],[14.75,422.0],[15.00,421.2],[15.25,
    419.8],[15.50,418.7],[15.75,418.4],[16.00,417.8],[16.25,417.1],[16.50,416.5],[16.75,
    415.7],[17.00,414.9],[17.25,414.0],[17.50,412.9],[17.75,412.1],[18.00,411.6],[18.25,
    411.5],[18.50,411.0],[18.75,410.5],[19.00,410.0],[19.25,409.2],[19.50,408.4],[19.75,
    407.4],[20.00,406.5],[20.25,405.5],[20.50,404.5],[20.75,403.4],[21.00,402.0],[21.25,
    401.7],[21.50,401.3],[21.75,400.7],[22.00,400.1],[22.25,399.4],[22.50,398.7],[22.75,
    397.9],[23.00,397.2],[23.25,396.4],[23.50,395.6],[23.75,394.8],[24.00,394.0],[24.25,
    393.2],[24.50,392.4],[24.75,391.6],[25.00,390.8],[25.25,390.0],[25.50,389.3],[25.75,
    388.6],[26.00,387.8],[26.25,387.0],[26.50,386.3],[26.75,385.5],[27.00,384.7],[27.25,
    383.9],[27.50,383.1],[27.75,382.3],[28.00,381.5],[28.25,380.7],[28.50,379.9],[28.75,
    379.2],[29.00,378.5],[29.25,377.7],[29.50,377.0],[29.75,376.2],[30.00,375.4],[30.25,
    374.6],[30.50,373.8],[30.75,373.0],[31.00,372.1],[31.25,371.3],[31.50,370.5],[31.75,
    369.7],[32.00,368.9],[32.25,368.0],[32.50,367.2],[32.75,366.4],[33.00,365.5],[33.25,
    364.7],[33.50,363.8],[33.75,363.0],[34.00,362.1],[34.25,361.2],[34.50,360.4],[34.75,
    359.5],[35.00,358.6],[35.25,357.7],[35.50,356.8],[35.75,355.9],[36.00,355.0],[36.25,
    354.0],[36.50,353.1],[36.75,352.2],[37.00,351.3],[37.25,350.4],[37.50,349.5],[37.75,
    348.6],[38.00,347.7],[38.25,346.8],[38.50,345.9],[38.75,345.0],[39.00,344.2],[39.25,
    343.3],[39.50,342.4],[39.75,341.5],[40.00,340.6],[40.25,339.7],[40.50,338.9],[40.75,
    338.0],[41.00,337.2],[41.25,336.3],[41.50,335.4],[41.75,334.5],[42.00,333.6],[42.25,
    332.7],[42.50,331.7],[42.75,330.7],[43.00,329.5],[43.25,328.1],[43.50,326.8],[43.75,
    325.7],[44.00,325.0],[44.25,324.7],[44.50,324.5],[44.75,324.4],[45.00,324.1],[45.25,
    323.2],[45.50,321.3],[45.75,319.1],[46.00,317.7],[46.25,316.9],[46.50,315.2],[46.75,
    313.8],[47.00,313.3],[47.25,313.1],[47.50,312.2],[47.75,310.9],[48.00,309.4],[48.25,
    308.1],[48.50,307.2],[48.75,306.6],[49.00,305.6],[49.25,304.6],[49.50,303.5],[49.75,
    302.4],[50.00,301.2],[50.25,300.0],[50.50,298.7],[50.75,297.4],[51.00,296.1],[51.25,
    294.7],[51.50,293.4],[51.75,292.1],[52.00,290.8],[52.25,289.5],[52.50,288.3],[52.75,
    287.2],[53.00,286.1],[53.25,285.2],[53.50,284.7],[53.75,283.9],[54.00,282.9],[54.25,
    281.8],[54.50,280.6],[54.75,279.4],[55.00,278.2],[55.25,277.0],[55.50,275.8],[55.75,
    274.7],[56.00,273.5],[56.25,272.2],[56.50,270.9],[56.75,269.5],[57.00,268.2],[57.25,
    267.1],[57.50,266.0],[57.75,265.0],[58.00,263.8],[58.25,262.4],[58.50,260.6],[58.75,
    258.4],[59.00,255.9],[59.25,253.2],[59.50,250.3],[59.75,247.3],[60.00,244.1],[60.25,
    240.8],[60.50,237.5],[60.75,234.1],[61.00,230.7],[61.25,227.3],[61.50,224.0],[61.75,
    220.8],[62.00,218.7]
  ];

  function yOfLat(lat) {
    var pts = LAT_Y;
    if (lat <= pts[0][0]) return pts[0][1];
    if (lat >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid][0] < lat) lo = mid; else hi = mid;
    }
    var y0 = pts[lo][1], y1 = pts[hi][1], x0 = pts[lo][0], x1 = pts[hi][0];
    return y0 + (y1 - y0) * (lat - x0) / (x1 - x0);
  }

  function project(lat, lng) {
    return { x: LON.a * lng + LON.b, y: yOfLat(lat) };
  }

  // world.svg 文本按 src 缓存;每次 render 从缓存克隆(筛选切换不重复解析)
  var _svgText = null, _svgSrc = '', _svgLoading = null;

  function loadSvg(src, cb) {
    if (_svgText && _svgSrc === src) { cb(); return; }
    if (_svgLoading && _svgSrc === src) { _svgLoading.then(function () { cb(); }); return; } // 已在途:等同一份
    _svgSrc = src;
    _svgLoading = fetch(src)
      .then(function (r) { if (!r.ok) throw new Error('svg'); return r.text(); })
      .then(function (text) { _svgText = text; return text; })
      .catch(function () { return null; });
    _svgLoading.then(function () { cb(); });
  }

  /** 提前开始下载 world.svg(与 /api 请求并行),到 render 时通常已在缓存 */
  function prefetch(src) {
    loadSvg(src || '/images/world.svg', function () {});
  }

  /**
   * 渲染地图:注入内联 SVG + 城市点位 + 缩放平移(照抄 geoguide 首页实现)。
   * @param {Object} conf  { container, cities, onCityClick, image, onRendered }
   */
  function render(conf) {
    var host = document.getElementById(conf.container);
    var done = function () { if (conf.onRendered) conf.onRendered(); };
    if (!host) { done(); return; }

    // 城市点 → viewBox 坐标。投影不出有限坐标的点(数据缺 lat/lng → NaN)在此剔掉:
    // 一个 NaN 点会让 fitToPoints 的 min/max 全变 NaN,进而把整个取景写坏。
    // 生产 schema 是 lat/lng REAL NOT NULL,碰不到;这是给畸形数据兜底。
    // 必须在这里过滤(而不是在 buildDots 里),否则 dots 与 cities 的下标会错位 ——
    // pickDot 返回的下标是拿去索引 cities 的。
    var cities = (conf.cities || []).map(function (c) {
      var p = project(c.lat, c.lng);
      return { c: c, u: p.x, v: p.y };
    }).filter(function (d) { return isFinite(d.u) && isFinite(d.v); });

    // 已初始化(首次 render 之后):只换数据集,不重建底图、不重挂事件、不碰缩放平移。
    // → 筛选勾选不再复位到全世界视角,也不再重解析 1MB world.svg(2026-09-05)。
    if (host._dtmap) {
      host._dtmap.applyData(cities);
      if (conf.onRendered) conf.onRendered(); // reveal 幂等,重复调用无害
      return;
    }

    loadSvg(conf.image || '/images/world.svg', function () {
      if (!_svgText) { done(); return; } // 加载失败:保持空容器,但仍通知宿主收尾
      var tmp = document.createElement('div');
      tmp.innerHTML = _svgText;
      var svg = tmp.querySelector('svg');
      if (!svg) { done(); return; }
      svg.setAttribute('width', '100%');
      svg.removeAttribute('aria-label');
      host.innerHTML = '';
      host.appendChild(svg);
      host._dtmap = initMap(host, svg, cities, conf);
      done(); // 地图渲染完再 reveal,页面内容一起出现
    });
  }

  function initMap(host, svg, initCities, conf) {
    var NS = 'http://www.w3.org/2000/svg';
    var zoom = { scale: 1, tx: 0, ty: 0 };
    // 闭包当前数据集:首帧=initCities;applyData 换数据时重指向。缩放/平移/事件只建一次。
    var cities = initCities;
    var dots = [];       // 城市点 {d, el, r0}(applyData 重建)
    // 指针手势状态(Pointer 事件,兼容触屏):
    //   pointers  Map<pointerId, {x,y}> —— 各指宿主局部坐标(client − host rect)
    //   drag      单指拖动基线 {sx, sy, stx, sty, moved}(宿主局部坐标)
    //   pinchRef  双指捏合基线 {d0, s0, tx0, ty0, mx0, my0}
    //   allowTap  本次手势是否仍可视为点按(移动/多指即置 false)
    var pointers = new Map();
    var drag = null;        // {sx, sy, stx, sty, moved}
    var pinchRef = null;    // {d0, s0, tx0, ty0, mx0, my0}
    var allowTap = true;    // 手势结束前是否仍允许触发点按
    var tipEl = null;       // 悬浮提示元素(initMap 尾部创建)
    var pickerEl = null;    // 「邻近城市」选择器元素(点中重叠区时创建)

    // ---- 数据集绘制(首帧与 applyData 复用单一来源):国家着色 + 城市点 + 空态 ----
    // 注意:paths 在下方首次赋值;colorCountries 被调用时 paths 已就绪。
    function colorCountries(cityList) {
      for (var ai = 0; ai < paths.length; ai++) paths[ai].classList.remove('has-data');
      if (!cityList.length) return;
      for (var pi = 0; pi < paths.length; pi++) {
        var p = paths[pi];
        if (typeof p.isPointInFill !== 'function') continue;
        for (var ci = 0; ci < cityList.length; ci++) {
          if (p.isPointInFill(new DOMPoint(cityList[ci].u, cityList[ci].v))) { p.classList.add('has-data'); break; }
        }
      }
    }
    function buildDots(cityList) {
      for (var ri = 0; ri < dots.length; ri++) {
        var oldEl = dots[ri].el;
        if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
      }
      dots = cityList.map(function (d, idx) {
        var r0 = dotRadiusFor(d.c.count); // 基准屏幕半径(px),放大按 1/s 反缩
        var circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('cx', String(d.u));
        circle.setAttribute('cy', String(d.v));
        circle.setAttribute('class', 'city-dot');
        circle.setAttribute('data-idx', String(idx));
        circle.setAttribute('role', 'button');
        circle.setAttribute('aria-label', d.c.city + ' · ' + d.c.count + ' 场');
        svg.appendChild(circle);
        return { d: d, el: circle, r0: r0 };
      });
      return dots;
    }

    // ---- 聚合点(zoom-out 拥挤治理) ----
    // 两可见点**圆盘相交**(圆心距 < 半径和·K_REF,半径含场次数)即画成一个聚合 <g>,
    // 圆心=成员均值、外加大标数字;圆半径/字号随 1/s 反缩、屏幕恒定;成员点隐藏,避免糊成一团。
    // 判定含尺寸 → 不会出现"两圆已重叠却各自可见"漏网;缩放变化时成员关系随之变化
    // (放大→间距超半径和 → 聚合解散),故每次 applyZoom 重算;仅成员关系变化才重建 DOM。
    var clusterLayer = null;    // 聚合 <g> 容器(置于城市点之上)
    var clusters = [];          // { ids:[dotIdx], cu, cv, crPx, gEl, cirEl, txtEl }
    var lastClusterSig = '';

    function clusterDistPx(a, b, sc) {
      return Math.hypot((dots[a].d.u - dots[b].d.u) * sc, (dots[a].d.v - dots[b].d.v) * sc);
    }
    /** 依当前屏幕比例(s·k)做传递聚类:两可见点**圆盘相交**即连成同一聚合(尺寸计入判定,
     *  与 dotOverlaps 同用「圆心距 < 半径和·K_REF」判据 → 聚合同判定一致,不会出现"视觉已
     *  重叠却还各自可见"的漏网)。返回组索引数组。 */
    function groupCities(sc) {
      var n = dots.length;
      var seen = new Array(n), groups = [];
      for (var i = 0; i < n; i++) {
        if (seen[i]) continue;
        seen[i] = 1;
        var stack = [i], ids = [i];
        while (stack.length) {
          var a = stack.pop();
          for (var b = 0; b < n; b++) {
            if (seen[b]) continue;
            if (clusterDistPx(a, b, sc) < (dots[a].r0 + dots[b].r0) * K_REF) {
              seen[b] = 1; stack.push(b); ids.push(b);
            }
          }
        }
        if (ids.length > 1) groups.push(ids);
      }
      return groups;
    }
    function clusterRadiusPx(count) {
      return Math.max(10, Math.min(6 + 2.1 * Math.sqrt(count), 16));
    }
    function clusterSig(groups) {
      return groups.map(function (g) { return g.slice().sort(function (x, y) { return x - y; }).join(','); }).sort().join(';');
    }
    function showDot(i) { dots[i].el.style.display = ''; }
    function hideDot(i) { dots[i].el.style.display = 'none'; }
    /** 重算聚合;成员关系变化则重建 DOM,并每帧按 s 更新半径/字号/线宽 */
    function updateClusters() {
      if (!dots.length) return;
      var s = zoom.scale;
      var k = (host.clientWidth || VIEW_W) / VIEW_W;
      var sc = k * s;
      var groups = groupCities(sc);
      var sig = clusterSig(groups);
      if (sig !== lastClusterSig) {
        lastClusterSig = sig;
        // 恢复全部点可见,再按新成员关系隐藏
        for (var i = 0; i < dots.length; i++) showDot(i);
        if (!clusterLayer) { clusterLayer = document.createElementNS(NS, 'g'); clusterLayer.setAttribute('class', 'city-clusters'); }
        while (clusterLayer.firstChild) clusterLayer.removeChild(clusterLayer.firstChild);
        clusters = [];
        groups.forEach(function (g) {
          var cu = 0, cv = 0;
          for (var gi = 0; gi < g.length; gi++) { cu += dots[g[gi]].d.u; cv += dots[g[gi]].d.v; }
          cu /= g.length; cv /= g.length;
          var gg = document.createElementNS(NS, 'g');
          // 超阈值簇标 is-mute:淡化 + 去手型 + 去 hover,别长着「可点」的样子。
          // 真闸在 pickCluster(JS 侧几何命中排除),这里只是让视觉跟上行为(2026-09-15)。
          if (g.length > CLUSTER_PICK_MAX) gg.setAttribute('class', 'is-mute');
          var cir = document.createElementNS(NS, 'circle');
          var txt = document.createElementNS(NS, 'text');
          // 内联 fill/对齐兜底(旧 CSS 无 .city-clusters 时也不退成底图米灰、不散位);
          // CSS 加载后同值覆盖,无副作用
          cir.setAttribute('fill', accentColor());
          cir.setAttribute('stroke', themeVar('--dot-stroke', 'rgba(20,22,29,0.90)'));
          txt.setAttribute('fill', themeVar('--on-accent', '#14161d'));
          txt.setAttribute('text-anchor', 'middle');
          txt.setAttribute('dominant-baseline', 'central');
          txt.setAttribute('font-weight', '700');
          txt.textContent = String(g.length);
          gg.appendChild(cir); gg.appendChild(txt);
          clusterLayer.appendChild(gg);
          clusters.push({ ids: g, cu: cu, cv: cv, crPx: clusterRadiusPx(g.length), gEl: gg, cirEl: cir, txtEl: txt });
          for (var h = 0; h < g.length; h++) hideDot(g[h]);
        });
        // 徽章置于城市点之下:拆出的近邻点画在徽章上、不被盖住(命中先点后徽章)
        if (dots.length) svg.insertBefore(clusterLayer, dots[0].el);
        else svg.appendChild(clusterLayer);
      }
      // 每帧:半径/数字/描边 随 1/s 反缩(屏幕恒定)
      for (var c = 0; c < clusters.length; c++) {
        var cl = clusters[c];
        cl.gEl.setAttribute('transform', 'translate(' + cl.cu.toFixed(2) + ' ' + cl.cv.toFixed(2) + ')');
        cl.cirEl.setAttribute('r', String(cl.crPx / k / s));
        cl.cirEl.setAttribute('stroke-width', String(DOT_STROKE / s));
        cl.txtEl.setAttribute('font-size', String(CLUSTER_FS / k / s));
      }
    }
    function clusterLocalPx(c) {
      var s = zoom.scale;
      var k = (host.clientWidth || VIEW_W) / VIEW_W;
      return { x: zoom.tx + c.cu * k * s, y: zoom.ty + c.cv * k * s };
    }
    /** 清空聚合层(数据集更换时调用),并恢复全部点可见 */
    function resetClusters() {
      lastClusterSig = '';
      clusters = [];
      if (clusterLayer) { while (clusterLayer.firstChild) clusterLayer.removeChild(clusterLayer.firstChild); }
      for (var i = 0; i < dots.length; i++) showDot(i);
    }
    /** 命中聚合点(局部坐标):取命中区内最近的一簇;返回集群下标或 -1。
     *  移动端触摸状态下放大容差(16px),避免手指按偏无法命中。 */
    function pickCluster(mx, my, isTouch) {
      var best = -1, bestD = 1e9;
      var extraTol = isTouch ? 16 : 3;
      for (var i = 0; i < clusters.length; i++) {
        var p = clusterLocalPx(clusters[i]);
        var r = clusters[i].crPx + extraTol;
        var d = (mx - p.x) * (mx - p.x) + (my - p.y) * (my - p.y);
        if (d <= r * r && d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    /** 点聚合点:
     *  - ≤ CLUSTER_PICK_MAX 城:弹成员「邻近城市」列表选择器
     *  - > CLUSTER_PICK_MAX 城:不展开超长列表,而是平滑聚焦放大该区域(1.8x),
     *    自然将其拆散为可点击的更小簇或独立城市点,彻底解决移动端大点点不动、误以为死锁的问题。 */
    function tapCluster(ci, x, y) {
      var c = clusters[ci];
      if (c.ids.length > CLUSTER_PICK_MAX) {
        var p = clusterLocalPx(c);
        zoomAt(1.8, p.x, p.y);
        return;
      }
      openPickerFor(c.ids.slice(), x, y);
    }
    var emptyNote = null;
    function syncEmpty(isEmpty) {
      if (isEmpty) {
        if (!emptyNote) { emptyNote = document.createElement('p'); emptyNote.className = 'map-empty'; host.appendChild(emptyNote); }
        emptyNote.textContent = '该类型暂无演出数据';
      } else if (emptyNote) { emptyNote.remove(); emptyNote = null; }
    }
    /** 换数据集(第二次起的 render 调用):不动 svg 结构/省界/事件/缩放 */
    function applyData(cityList) {
      cities = cityList;
      colorCountries(cities);
      buildDots(cities);
      updateDots(zoom.scale);          // 新点按当前缩放设 r / 描边
      resetClusters();                 // 数据集换了 → 旧的聚合 DOM 作废,重算
      updateClusters();
      syncEmpty(cities.length === 0);
      closePicker();
      hideTip();
    }

    // ---- 1) 有数据的国家着色(点位于该 path 内部) ----
    var paths = Array.prototype.filter.call(svg.querySelectorAll('path'), function (p) {
      return !(p.classList && p.classList.contains('nine-dash-line'));
    });
    colorCountries(cities);

    // ---- 1b) 中国内部省界(大陆标准,台湾即省;仅内部省界,不含国境/海岸/海岛省界)
    // 叠加在国界之上、城市点之下;clip 到中国轮廓,省界端贴岸时不高倍下越出海。
    var cnEl = svg.querySelector('path#cn');
    if (cnEl && window.CHINA_PROVINCE_SEAMS && window.CHINA_PROVINCE_SEAMS.length) {
      var seamG = document.createElementNS(NS, 'g');
      seamG.setAttribute('class', 'province-seams');
      var clipId = 'cn-clip-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
      var clipPathEl = document.createElementNS(NS, 'clipPath');
      clipPathEl.id = clipId;
      var cnCopy = cnEl.cloneNode(true);           // 复用底图中国轮廓(含港澳台/岛屿)作裁剪
      cnCopy.removeAttribute('class');
      cnCopy.removeAttribute('id');
      clipPathEl.appendChild(cnCopy);
      svg.insertBefore(clipPathEl, svg.firstChild);
      seamG.setAttribute('clip-path', 'url(#' + clipId + ')');
      var dParts = [];
      for (var si = 0; si < window.CHINA_PROVINCE_SEAMS.length; si++) {
        var pll = window.CHINA_PROVINCE_SEAMS[si];
        if (!pll || pll.length < 2) continue;
        var pA = project(pll[0][1], pll[0][0]);
        var dLine = 'M' + pA.x.toFixed(2) + ' ' + pA.y.toFixed(2);
        for (var sj = 1; sj < pll.length; sj++) {
          var pB = project(pll[sj][1], pll[sj][0]);
          dLine += 'L' + pB.x.toFixed(2) + ' ' + pB.y.toFixed(2);
        }
        dParts.push(dLine);
      }
      if (dParts.length) {
        var seamPath = document.createElementNS(NS, 'path');
        seamPath.setAttribute('d', dParts.join(''));
        seamPath.setAttribute('class', 'province-line');
        seamPath.setAttribute('aria-hidden', 'true');
        // 初始(scale=1)线宽;之后由 updateStrokes(s) 按 0.5/s 跟随缩放。
        // 注意 style.css 的 .province-line 不写 stroke-width,否则会覆盖本 attribute。
        seamPath.setAttribute('stroke-width', '0.5');
        seamG.appendChild(seamPath);
      }
      svg.appendChild(seamG);
    }

    // ---- 2) 城市点位(SVG 圆点) ----
    buildDots(cities);

    // ---- 3) 缩放 / 平移(viewBox 窗口,锚定鼠标) ----
    // 缩放载体现为 svg 的 viewBox,**不是** CSS transform(2026-09-11 从 transform 改过来)。
    // 原因:WebKit 会把带 CSS transform 的 <svg> 按**布局尺寸**光栅化一次,之后由合成器把这张
    // 位图放大(WebKit Bug 27684,2009 至今未修);本图手机端布局宽仅 ~350px,放到 16× 就是
    // 350px 位图拉 16 倍 —— Safari 上必糊,且越放大越糊。Chrome/Firefox 会在合成分辨率重新
    // 光栅化,所以只有 Safari 中招:A/B 实测 Chrome 下两法锐度同为 1.00×(即 Chrome 测不出差别,
    // 别拿它当"没问题"的证据)。换 viewBox 后视图与原来**完全等价**(屏幕 px/user-unit 同为 k·s),
    // 但内容由 SVG 渲染器按新 CTM 直接画进布局尺寸,分辨率不再被拉伸。
    // user-unit 坐标空间不变 → 点位半径、省界线宽、clipPath 的既有反缩数学全部照旧。
    function clampScale(s) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s)); }
    function applyZoom() {
      closePicker(); // 缩放后点间距离已变,重叠态随之改变,选择器作废
      var W = host.clientWidth || 1;
      var H = host.clientHeight || 1;
      var s = zoom.scale;
      zoom.tx = Math.min(0, Math.max(W * (1 - s), zoom.tx));
      zoom.ty = Math.min(0, Math.max(H * (1 - s), zoom.ty));
      // 屏幕 px = tx + u·k·s ⇔ 可见窗口左上角 user-unit = −tx/(k·s),宽高 = VIEW/s
      var k = W / VIEW_W;
      var vx = -zoom.tx / (k * s), vy = -zoom.ty / (k * s), vw = VIEW_W / s, vh = VIEW_H / s;
      // 兜底:一旦非有限,宁可视窗回落全世界,也不要写出非法 viewBox —— 非法值会被 SVG
      // 解析器**整条丢弃**(不是取部分),地图于是错位到左上角 350×231 单位。旧版写的是
      // CSS transform,非法值只被静默忽略,所以这条路以前不报错也看不出来。
      if (!(isFinite(vx) && isFinite(vy) && isFinite(vw) && isFinite(vh)) || vw <= 0 || vh <= 0) {
        vx = 0; vy = 0; vw = VIEW_W; vh = VIEW_H;
      }
      svg.setAttribute('viewBox', vx.toFixed(4) + ' ' + vy.toFixed(4) + ' ' + vw.toFixed(4) + ' ' + vh.toFixed(4));
      updateDots(s);
      updateStrokes(s);
      updateClusters();   // 聚合成员随屏幕距离变化:缩放即重算
    }
    // 点位半径 + 描边随缩放反向:整体屏幕尺寸恒定,橙色核心不消失
    function updateDots(s) {
      // 屏幕恒定:点半径/描边 = r0·K_REF(px),与聚合点同一模型,窄地图不缩小。
      // 属性存 user-unit(显示 px = attr·k·s),故除以 k 抵消 host 宽。
      var k = (host.clientWidth || VIEW_W) / VIEW_W;
      var rr = (K_REF / k) / s;
      var sw = (DOT_STROKE * K_REF / k) / s;
      for (var i = 0; i < dots.length; i++) {
        dots[i].el.setAttribute('r', String(dots[i].r0 * rr));
        dots[i].el.setAttribute('stroke-width', String(sw));
      }
    }
    // 省界线宽按 1/s 设 user-unit attribute(屏幕线宽恒定 ~0.5px,放大不变粗)。
    // 国界/九段线宽不再由 JS 设——交给 style.css 的 viewBox 单位 stroke-width
    // (随缩放走,同 geoguide 首页),以盖住 DataV 中国与 @svg 邻国的 ~1px 贴边错位。
    // 注意:style.css 不可给 .province-line 写 stroke-width,否则覆盖本 attribute。
    function updateStrokes(s) {
      var ps = svg.querySelectorAll('path.province-line');
      var w = (0.5 / s).toFixed(4);
      for (var i = 0; i < ps.length; i++) ps[i].setAttribute('stroke-width', w);
    }
    function updateZoomButtons() {
      if (zoomIn) zoomIn.disabled = zoom.scale >= ZOOM_MAX - 0.001;
      if (zoomOut) zoomOut.disabled = zoom.scale <= ZOOM_MIN + 0.001;
    }
    /** 首次取景:围绕全部提交点自动居中取景(留 ~6% 边),但缩放有**上限**——
     *  可见经度 ≥ 约一个大国范围(AUTO_FIT_MIN_LON_DEG),数据挤在一小簇时不深钻;
     *  数据本身覆盖更广 → 自动放大到包住数据,最大世界全图。与地理位置无关。
     *  仅首帧调用一次:筛选切换走 applyData 不复位视角(见 render 注释)。 */
    function fitToPoints() {
      if (!cities.length) return;
      var W = host.clientWidth, H = host.clientHeight;
      if (!W || !H) return; // 宿主尚未布局(正常不会发生),保持默认视角
      var k = W / VIEW_W;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < cities.length; i++) {
        var u = cities[i].u, v = cities[i].v;
        if (u < minX) minX = u; if (u > maxX) maxX = u;
        if (v < minY) minY = v; if (v > maxY) maxY = v;
      }
      var margin = Math.round(Math.min(W, H) * 0.06);
      var sx = (W - 2 * margin) / Math.max((maxX - minX) * k, 1e-3);
      var sy = (H - 2 * margin) / Math.max((maxY - minY) * k, 1e-3);
      // 放大上限:可见经度 = VIEW_W / (scale * LON.a) ≥ AUTO_FIT_MIN_LON_DEG
      var cap = VIEW_W / (AUTO_FIT_MIN_LON_DEG * LON.a);
      var s = Math.min(sx, sy, cap);
      if (s <= 1) return; // 数据已铺满(或超过)全图:世界视角本就全可见
      zoom.scale = s;
      zoom.tx = W / 2 - ((minX + maxX) / 2) * k * s;
      zoom.ty = H / 2 - ((minY + maxY) / 2) * k * s;
    }
    function zoomAt(factor, cx, cy) {
      var ns = clampScale(zoom.scale * factor);
      factor = ns / zoom.scale;
      zoom.tx = cx - factor * (cx - zoom.tx);
      zoom.ty = cy - factor * (cy - zoom.ty);
      zoom.scale = ns;
      applyZoom();
      updateZoomButtons();
    }

    // 缩放按钮(左下)
    var zoomCtrl = document.createElement('div');
    zoomCtrl.className = 'map__zoom';
    var zoomIn = document.createElement('button');
    zoomIn.type = 'button'; zoomIn.setAttribute('aria-label', '放大'); zoomIn.textContent = '+';
    var zoomOut = document.createElement('button');
    zoomOut.type = 'button'; zoomOut.setAttribute('aria-label', '缩小'); zoomOut.textContent = '−';
    zoomCtrl.appendChild(zoomIn); zoomCtrl.appendChild(zoomOut);
    function centerPx() {
      var r = host.getBoundingClientRect();
      return { x: r.width / 2, y: r.height / 2 };
    }
    zoomIn.addEventListener('click', function (e) {
      e.stopPropagation(); var c = centerPx(); zoomAt(1.5, c.x, c.y);
    });
    zoomOut.addEventListener('click', function (e) {
      e.stopPropagation(); var c = centerPx(); zoomAt(1 / 1.5, c.x, c.y);
    });

    // 滚轮缩放(锚定鼠标)
    host.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = host.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // 拖动平移 / 双指捏合(Pointer 事件,兼容触屏);移动过或多指即抑制点击
    function screenToSvg(e) {
      var r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function localXY(e) {
      var r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function pointerDown(e) {
      if (e.target.closest && e.target.closest('.map__zoom')) return;
      if (!pointers.size) {
        // 新手势(首指):重置本次手势状态
        drag = null;
        pinchRef = null;
        allowTap = true;
        closePicker(); // 用户在地图上重新点按 → 收掉已开的邻近城市选择器
      }
      pointers.set(e.pointerId, localXY(e));
      if (pointers.size === 1) {
        var p = pointers.get(e.pointerId);
        drag = { sx: p.x, sy: p.y, stx: zoom.tx, sty: zoom.ty, moved: false, pointerType: e.pointerType };
        try { if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId); } catch (err) {}
      } else if (pointers.size === 2) {
        // 第二指 → 进入捏合;结束单指拖动画,记录捏合基线
        drag = null;
        var arr = Array.from(pointers.values());
        pinchRef = {
          d0: Math.max(Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y), 1),
          s0: zoom.scale, tx0: zoom.tx, ty0: zoom.ty,
          mx0: (arr[0].x + arr[1].x) / 2,
          my0: (arr[0].y + arr[1].y) / 2
        };
        allowTap = false; // 多指手势绝不当作点按
        try { if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId); } catch (err) {}
      }
      svg.style.cursor = 'grabbing';
    }

    function pointerMove(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, localXY(e));
      if (pinchRef && pointers.size >= 2) {
        var arr = Array.from(pointers.values());
        var a = arr[0], b = arr[1];
        var d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
        var ns = clampScale(pinchRef.s0 * d / pinchRef.d0);
        var factor = ns / pinchRef.s0;
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        zoom.scale = ns;
        // 锚定捏合中点:缩放手势同时平移,中点下方内容保持
        zoom.tx = mx - factor * (pinchRef.mx0 - pinchRef.tx0);
        zoom.ty = my - factor * (pinchRef.my0 - pinchRef.ty0);
        allowTap = false;
        applyZoom();
        updateZoomButtons();
        hideTip();
        return;
      }
      if (pointers.size === 1 && drag) {
        var p = pointers.get(e.pointerId);
        var dx = p.x - drag.sx, dy = p.y - drag.sy;
        // 移动端手指接触面大,抬起存在生理微动;触控容差放大到 16px(工业标准 touch slop),避免误判为拖拽
        var moveThresh = (e.pointerType === 'touch' || drag.pointerType === 'touch') ? 16 : 5;
        if (Math.abs(dx) + Math.abs(dy) > moveThresh) { drag.moved = true; allowTap = false; }
        if (drag.moved) {
          zoom.tx = drag.stx + dx;
          zoom.ty = drag.sty + dy;
          applyZoom();
          hideTip();
        }
      }
    }

    function pointerUp(e) {
      var hadPinch = !!pinchRef;
      pointers.delete(e.pointerId);
      try { if (svg.releasePointerCapture) svg.releasePointerCapture(e.pointerId); } catch (err) {}
      if (hadPinch && pointers.size === 1) {
        // 双指 → 剩一指:捏合结束,转单指续拖(起点=剩指当前位置;moved=true 抑制误点)
        var rem = Array.from(pointers.values())[0];
        drag = { sx: rem.x, sy: rem.y, stx: zoom.tx, sty: zoom.ty, moved: true, pointerType: e.pointerType };
        pinchRef = null;
        allowTap = false;
      } else if (!hadPinch && drag) {
        // 单指手势结束
        if (!drag.moved) {
          // 轻点(未拖动):仅当整场手势仍允许 tap 且是末指抬起
          if (pointers.size === 0 && allowTap) {
            var p = screenToSvg(e);
            var isTouch = e.pointerType === 'touch' || drag.pointerType === 'touch' ||
              (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
            // 命中顺序与绘制层级一致(点在上、徽章在下):先试可见点,再试聚合徽章
            var idx = pickDot(p.x, p.y, isTouch);
            if (idx >= 0) {
              // 命中点与可见邻点在当前缩放下重叠 → 先弹「邻近城市」选择器,选中再开弹窗
              if (!openPicker(idx, p.x, p.y) && conf.onCityClick) conf.onCityClick(cities[idx].c);
            } else {
              var ci = pickCluster(p.x, p.y, isTouch);
              if (ci >= 0) {
                tapCluster(ci, p.x, p.y);   // 点中聚合点:弹成员列表
              }
            }
          }
        }
        drag = null;
      }
      if (pointers.size === 0) {
        pinchRef = null;
        drag = null;
        svg.style.cursor = 'grab';
        allowTap = true; // 手势结束,复位
      }
    }
    svg.addEventListener('pointerdown', pointerDown);
    svg.addEventListener('pointermove', pointerMove);
    svg.addEventListener('pointerup', pointerUp);
    svg.addEventListener('pointercancel', pointerUp);

    // 命中城市点(屏幕坐标)
    // 注意:SVG 的 viewBox(1010)被渲染到容器宽度时有一层显示缩放 k,
    // 命中检测必须乘上 k,否则 zoom=1 时也差(容器宽-1010)px,点不到。
    function dotScreen(d) {
      var r = host.getBoundingClientRect();
      var s = zoom.scale;
      var k = (host.clientWidth || VIEW_W) / VIEW_W;
      return { x: r.left + zoom.tx + d.u * k * s, y: r.top + zoom.ty + d.v * k * s };
    }
    function pickDot(mx, my, isTouch) {
      var r = host.getBoundingClientRect();
      var best = -1, bestD = 1e9;
      // 触控设备手指触控靶区放大到 18px 容差(对应 ~44px 触控区),鼠标保持 3px 紧凑
      var extraTol = isTouch ? 18 : 3;
      for (var i = 0; i < dots.length; i++) {
        if (dots[i].el.style.display === 'none') continue; // 聚合成员的隐藏点不参与单点命中
        var p = dotScreen(dots[i].d);
        var dx = mx - (p.x - r.left), dy = my - (p.y - r.top);
        var dist = dx * dx + dy * dy;
        var tol = dots[i].r0 + extraTol;
        var tol2 = tol * tol;
        if (dist <= tol2 && dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
      return best;
    }

    // ---- 4) 近邻城市重叠 → 「邻近城市」选择器 ----
    // 仅当可见圆盘**真正几何相交**(圆心距 < 两实画半径和 r0·k)才弹选择器;
    // 盘不交则直接开点中的那个城(2026-09-07:去掉原 +3px 容差——深/港、高雄/台南
    // 放到最大时圆心距其实已 > 两半径和,留有缝/恰相切,不应再被误判为重叠要求选择)。
    function dotOverlaps(i, j) {
      if (dots[i].el.style.display === 'none' || dots[j].el.style.display === 'none') return false; // 聚合隐藏点不入重叠组
      var k = (host.clientWidth || VIEW_W) / VIEW_W;
      var s = zoom.scale;
      var ax = zoom.tx + dots[i].d.u * k * s, ay = zoom.ty + dots[i].d.v * k * s;
      var bx = zoom.tx + dots[j].d.u * k * s, by = zoom.ty + dots[j].d.v * k * s;
      return Math.hypot(ax - bx, ay - by) < (dots[i].r0 + dots[j].r0) * K_REF;
    }
    function collectOverlap(start) {
      var grp = [], seen = {}, stack = [start];
      seen[start] = 1;
      while (stack.length) {
        var i = stack.pop(); grp.push(i);
        for (var j = 0; j < dots.length; j++) {
          if (seen[j]) continue;
          if (dotOverlaps(i, j)) { seen[j] = 1; stack.push(j); }
        }
      }
      return grp;
    }
    function onPickerKey(ev) { if (ev.key === 'Escape') closePicker(); }
    function onPickerDocDown(ev) {
      if (pickerEl && !pickerEl.hidden && !pickerEl.contains(ev.target)) closePicker();
    }
    function ensurePicker() {
      if (!pickerEl) {
        pickerEl = document.createElement('div');
        pickerEl.className = 'map-picker';
        pickerEl.hidden = true;
        host.appendChild(pickerEl);
      }
      return pickerEl;
    }
    function closePicker() {
      if (pickerEl) { pickerEl.hidden = true; pickerEl.innerHTML = ''; }
      document.removeEventListener('pointerdown', onPickerDocDown);
      document.removeEventListener('keydown', onPickerKey);
    }
    /** 弹成员列表选择器(memberIds 为点序号数组,可为聚合成员或重叠组);返回是否真的弹了 */
    function openPickerFor(memberIds, x, y) {
      if (!memberIds || memberIds.length < 2) return false;
      var arr = memberIds.slice();
      arr.sort(function (a, b) { return (dots[b].d.c.count || 0) - (dots[a].d.c.count || 0) || a - b; });
      var el = ensurePicker();
      el.innerHTML = '';
      var title = document.createElement('div');
      title.className = 'map-picker__title';
      title.textContent = '邻近城市';
      el.appendChild(title);
      arr.forEach(function (i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'map-picker__item';
        b.textContent = dots[i].d.c.city + ' · ' + dots[i].d.c.count + ' 场';
        var selectCity = function (e) {
          if (e) e.stopPropagation();
          closePicker();
          if (conf.onCityClick) conf.onCityClick(dots[i].d.c);
        };
        b.addEventListener('click', selectCity);
        el.appendChild(b);
      });
      el.hidden = false;
      // ⚠️ 量尺寸前先把 left/top/字号/限高统统归零:本元素是**复用节点**,沿用上一轮的位置
      //   去量,量到的是「按旧位置换行」的尺寸;而绝对定位元素的 shrink-to-fit 宽又取决于
      //   left(可用宽 = 容器宽 − left),于是尺寸与位置互相追着变。与 placeTip 同一个坑。
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.fontSize = '';
      el.style.maxHeight = '';
      el.style.overflowY = '';
      var cw = host.clientWidth, ch = host.clientHeight;
      var m = PICKER_MARGIN, avail = ch - m * 2;
      // 列表放不下 → 按需缩字号(--fs-xs:12 → 下限 11);
      // 缩到下限仍放不下才让它自己滚(窄屏地图矮,只靠缩字号会缩到看不清)。
      var ph = el.offsetHeight;
      var fs = parseFloat(getComputedStyle(el).fontSize) || 12;
      while (ph > avail && fs > PICKER_FS_MIN) {
        fs -= 1;
        el.style.fontSize = fs + 'px';
        ph = el.offsetHeight;
      }
      if (ph > avail) { el.style.maxHeight = avail + 'px'; el.style.overflowY = 'auto'; ph = avail; }
      var pw = el.offsetWidth;   // 缩字号会改变换行 → 缩完再量宽
      var left = Math.max(m, Math.min(x + 14, cw - pw - m));
      var top = Math.min(Math.max(m, (y + ph + 16 > ch) ? y - ph - 10 : y + 16), Math.max(m, ch - ph - m));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      hideTip(); // 弹选择器即收掉悬浮黑卡:点击后只保留「邻近城市」选择器(2026-09-08)
      document.addEventListener('pointerdown', onPickerDocDown);
      document.addEventListener('keydown', onPickerKey);
      return true;
    }
    /** 命中单个可见点 idx:其可见重叠组 ≥2 → 弹选择器;否则由调用方直接开弹窗 */
    function openPicker(idx, x, y) {
      var grp = collectOverlap(idx);
      return openPickerFor(grp, x, y);
    }

    // 悬浮提示:城市 · 场次(单点);N 城 · M 场(聚合点)
    function hideTip() { if (tipEl) tipEl.hidden = true; }
    /**
     * 摆黑卡。传入 hitR = 当前悬停目标的**命中半径**(与点击判定同口径:p 点 r0+3、
     * 徽章 crPx+3),整块矩形保证不与该命中圆相交。
     *
     * 为什么必须让位(2026-09-15 修):原实现把黑卡固定锚在光标右上 (x+12, y-34)。
     * 命中圆半径最大到徽章的 16+3=19px(比例尺越小簇越大越接近上限),12 < 19,黑卡
     * 左下角于是落进命中圆内 —— 实测盖住所悬停徽章命中圆的约 46%。黑卡是
     * pointer-events:none,点在它上面会**穿透**到底下 —— 黑卡看起来写着「上海、镇江 等」,
     * 让人以为点它是在点那一簇,实际落到的却是穿透位置底下那个目标(可能压根不是同一簇)。
     *
     * ⚠️ 诊断更正(同上,2026-09-15):上一轮把「点大数字反而放大」也归到了黑卡头上,那是**错的**。
     * 真病根在 tapCluster —— 穿透过去落到的徽章,自己按下就是 zoomAt(2);黑卡让位之后
     * 实测点击依旧放大。让位该留(它治的是「点黑框误触到别的目标」),但别指望它治点击语义。
     * 见 tapCluster 注释。
     *
     * 几何依据:矩形左边 > 圆心 x + 命中半径 ⇒ 矩形上每点的 x 距圆心都 > 命中半径,
     * 与该圆必然不相交 —— **只靠横向让位就够,纵向位置不影响该保证**。
     */
    function placeTip(text, e, hitR) {
      if (!tipEl) return;
      var r = host.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      tipEl.textContent = text;
      tipEl.hidden = false;
      // ⚠️ 量尺寸前必须把 left/top 归零。绝对定位元素的 shrink-to-fit 宽度取决于 left
      // (可用宽 = 容器宽 − left):若沿用上一轮的 left 去量,量到的是「按旧位置换行」的尺寸,
      // 再拿它算出的新 left 又反过来改变换行 —— 尺寸与位置互相追着变。实测窄屏下量到
      // 158×79、最终却渲染成 240×57,黑卡于是又压回命中圆。归零后量,尺寸与位置无关;
      // 本次不触发重绘,无闪烁。
      tipEl.style.left = '0px';
      tipEl.style.top = '0px';
      var tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
      var cw = host.clientWidth, ch = host.clientHeight;
      var clear = (hitR || 0) + TIP_CLEAR_GAP;  // 让位量 = 命中半径 + 间隙
      var m = TIP_MARGIN;
      // 四选一;只要命中任一条,矩形与该命中圆就必然不相交(前两条靠横向,后两条靠纵向)
      var clampX = function (v) { return Math.max(m, Math.min(v, cw - tw - m)); };
      var clampY = function (v) { return Math.max(m, Math.min(v, ch - th - m)); };
      var left, top;
      if (x + clear + tw <= cw - m) {
        left = x + clear;                                  // ① 右侧(默认)
        top = clampY(y - th - 8 < m ? y + 8 : y - th - 8);
      } else if (x - clear - tw >= m) {
        left = x - clear - tw;                             // ② 右边放不下 → 整块挪到左侧
        top = clampY(y - th - 8 < m ? y + 8 : y - th - 8);
      } else if (y - clear - th >= m) {
        top = y - clear - th;                              // ③ 窄屏两侧都放不下 → 放到上方
        left = clampX(x + clear);
      } else if (y + clear + th <= ch - m) {
        top = y + clear;                                   // ④ 再退到下方
        left = clampX(x + clear);
      } else {
        // 四周都容不下「不与命中圆相交」的矩形(极窄且目标居中)——宁可不出黑卡,
        // 也不退回「压在目标上」:那正是本函数要根除的 bug。
        hideTip();
        return;
      }
      tipEl.style.left = left + 'px';
      tipEl.style.top = top + 'px';
    }
    function clusterTipText(ci) {
      var cl = clusters[ci];
      var total = 0, names = [];
      for (var q = 0; q < cl.ids.length; q++) {
        var dt = dots[cl.ids[q]].d;
        total += dt.c.count || 0;
        if (q < 3) names.push(dt.c.city);
      }
      var label = names.join('、') + (cl.ids.length > 3 ? ' 等' : '');
      return label + ' · ' + cl.ids.length + ' 城 / 共 ' + total + ' 场';
    }
    function showTip(i, e) {
      if (i < 0) { hideTip(); return; }
      // 让位半径与 pickDot 的命中容差同口径(r0 + 3)
      placeTip(cities[i].c.city + ' · ' + cities[i].c.count + ' 场', e, dots[i].r0 + 3);
    }
    function showClusterTip(ci, e) {
      if (ci < 0) { hideTip(); return; }
      // 让位半径与 pickCluster 的命中容差同口径(crPx + 3)
      placeTip(clusterTipText(ci), e, clusters[ci].crPx + 3);
    }
    // 悬浮黑卡只随**鼠标**显示:触摸点按不显示(避免与「邻近城市」选择器同屏重叠、遮一半)。
    // 改 pointermove 而非 mousemove —— 触摸结束后浏览器补发的合成 mousemove 不再触发黑卡。
    // 「邻近城市」选择器打开期间也不悬浮显示:点击后只保留选择器(2026-09-08)。
    svg.addEventListener('pointermove', function (e) {
      if (pointers.size) return;                 // 拖拽/捏合进行中
      if (e.pointerType !== 'mouse') return;     // 触摸/笔:不显示悬浮黑卡
      if (pickerEl && !pickerEl.hidden) return;  // 邻近城市选择器开着:只显示选择器
      var p = screenToSvg(e);
      var i = pickDot(p.x, p.y); // 命中顺序与绘制层级一致:点在上先于点
      if (i >= 0) { showTip(i, e); svg.style.cursor = 'pointer'; return; }
      var ci = pickCluster(p.x, p.y);
      if (ci >= 0) { showClusterTip(ci, e); svg.style.cursor = 'pointer'; return; }
      hideTip();
      svg.style.cursor = 'grab';
    });
    svg.addEventListener('pointerleave', hideTip);

    // 悬浮卡片元素
    tipEl = document.createElement('div');
    tipEl.className = 'map-tip';
    tipEl.hidden = true;
    host.appendChild(tipEl);

    host.appendChild(zoomCtrl);
    svg.style.cursor = 'grab';
    fitToPoints();   // 首帧按全部提交点自动取景(不再是世界全图)
    applyZoom();
    updateZoomButtons();

    // 无数据提示
    syncEmpty(cities.length === 0);

    return { applyData: applyData };
  }

  window.DTMap = { project: project, render: render, prefetch: prefetch, VIEW_W: VIEW_W, VIEW_H: VIEW_H };
})();
