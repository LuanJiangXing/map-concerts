/* fit-proj.js —— 经验投影拟合(供参考,不在运行时使用)
 *
 * 背景:world.svg 非标准经纬网格。本脚本用小国家的真实 SVG bbox 反推
 * 经纬度 → SVG 坐标 的映射:
 *   - 经度 → x 严格线性(最小二乘,RMSE≈2px);
 *   - 纬度 → y 单调三次样条(Fritsch–Carlson),再按 0.25° 采样成查表。
 *
 * 重要:部分国家的 bbox 中心在该投影下明显失真(形状不对称/比例怪异),
 * 会破坏 y 的单调性,直接把那些点拉进海里。所以:
 *   1. 先剔除这些 outlier(下方 OUT 集合,判定标准:破坏 y 随纬度单调递增,
 *      或斜率与邻点明显脱节);
 *   2. 用干净点拟合单调样条;
 *   3. 采样成 0.25° 查表写入 js/map.js 的 LAT_Y。
 *
 * 验证锚点(真实 SVG 几何):香港路径中心 (795.5,399.3) ↔ project(22.32,114.17)
 * 误差 < 1px;台北落在台湾 bbox 北端。详见脚本末尾验证输出。
 */

const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const svgPath = path.resolve(__dirname, '../public/images/world.svg');
  await p.goto('file://' + svgPath);
  await p.waitForSelector('path[id="cn"]');
  const all = await p.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('path')) {
      const id = el.getAttribute('id');
      if (!id) continue;
      const bb = el.getBBox();
      out[id] = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    }
    return out;
  });
  // compact-country reference dict: iso2 -> [lat, lon]
  const dict = {
    sg:[1.35,103.82],mt:[35.90,14.40],bh:[26.03,50.55],cy:[35.13,33.43],fj:[-17.71,178.07],
    is:[64.96,-19.02],mu:[-20.35,57.55],lk:[7.87,80.77],tl:[-8.87,125.87],bn:[4.50,114.70],
    kw:[29.37,47.99],qa:[25.35,51.18],lu:[49.82,6.13],pr:[18.22,-66.59],tt:[10.51,-61.29],
    bb:[13.17,-59.53],mv:[3.20,73.22],jm:[18.11,-77.30],cr:[9.93,-84.08],pa:[8.54,-80.78],
    ni:[12.87,-85.21],sv:[13.79,-88.90],hn:[14.97,-86.65],gt:[15.78,-90.23],bz:[17.19,-88.50],
    gy:[4.86,-58.93],sr:[3.92,-56.03],py:[-23.44,-58.44],uy:[-32.52,-55.77],bo:[-16.29,-63.59],
    ec:[-1.83,-78.18],pe:[-9.19,-75.02],zw:[-19.02,29.15],zm:[-13.13,27.85],mw:[-13.25,34.30],
    mg:[-18.77,46.87],cm:[7.37,12.35],gh:[7.95,-1.02],ci:[7.54,-5.55],sn:[14.50,-14.45],
    mr:[20.88,-10.94],ml:[17.57,-3.97],ne:[17.61,8.08],td:[15.45,18.73],so:[5.15,46.20],
    ye:[15.55,48.52],om:[21.51,55.92],np:[28.39,84.12],bt:[27.51,90.43],mm:[21.92,95.96],
    kh:[12.57,104.99],la:[19.86,102.50],vn:[14.06,108.28],kp:[40.34,127.51],mn:[46.86,103.85],
    kg:[41.20,74.77],ua:[48.38,31.17],by:[53.71,27.95],lt:[55.17,23.88],lv:[56.88,24.60],
    ee:[58.60,25.01],fi:[61.92,25.75],ie:[53.14,-8.24],dk:[56.26,9.50],nz:[-40.90,174.89],
    cy:[35.13,33.43],si:[46.15,14.99],hr:[45.10,15.20],ba:[44.31,17.68],mk:[41.61,21.75],
    al:[41.15,20.17],me:[42.71,19.37],rs:[44.02,21.01],sk:[48.67,19.70],cz:[49.82,15.47],
    at:[47.52,14.55],hu:[47.16,19.50],ro:[45.94,24.97],bg:[42.73,25.49],md:[47.41,28.37],
  };
  // 剔除 bbox 中心在该投影下明显失真的国家(判定:破坏 y 单调性/斜率脱节)
  const OUT = new Set(['vn','sn','ne','mm','ba','md','at','is']);
  const refs = [];
  for (const [id, [lat, lon]] of Object.entries(dict)) {
    if (OUT.has(id)) continue;
    const g = all[id];
    if (!g) continue;
    const area = g.w * g.h, maxd = Math.max(g.w, g.h);
    if (area < 5000 && maxd < 130) {
      refs.push({ id, lat, lon, cx: g.x + g.w/2, cy: g.y + g.h/2 });
    }
  }
  console.log('reference points used (' + refs.length + ', removed ' + [...OUT].join(',') + '):');
  // x linear fit in lon
  let sx=0,sy=0,sxx=0,sxy=0, n=0;
  for (const r of refs){ const X=r.lon, Y=r.cx; n++; sx+=X; sy+=Y; sxx+=X*X; sxy+=X*Y; }
  const aLon=(n*sxy-sx*sy)/(n*sxx-sx*sx), bLon=(sy-aLon*sx)/n;
  let rmse=0; for (const r of refs){ const e=r.cx-(aLon*r.lon+bLon); rmse+=e*e; }
  rmse=Math.sqrt(rmse/refs.length);
  console.log('\nx(lon) = ' + aLon.toFixed(4) + '*lon + ' + bLon.toFixed(2) + '   (RMSE=' + rmse.toFixed(1) + 'px)');
  // y monotone cubic spline in lat
  const pts0 = refs.map(r=>({x:r.lat, y:r.cy})).sort((p,q)=>p.x-q.x);
  const pts = [];
  for (const p of pts0) {
    if (pts.length && Math.abs(p.x - pts[pts.length-1].x) < 0.15) continue;
    pts.push(p);
  }
  function monotoneSpline(pts){
    const n=pts.length; const h=[], d=[], m=[];
    for(let i=0;i<n-1;i++){ h[i]=pts[i+1].x-pts[i].x; d[i]=(pts[i+1].y-pts[i].y)/h[i]; }
    m[0]=d[0]; m[n-1]=d[n-2];
    for(let i=1;i<n-1;i++) m[i]=(d[i-1]+d[i])/2;
    for(let i=0;i<n-1;i++){
      if(d[i]===0){ m[i]=0; m[i+1]=0; continue; }
      const a=m[i]/d[i], bb=m[i+1]/d[i];
      const s=a*a+bb*bb;
      if(s>9){ const t=3/Math.sqrt(s); m[i]=t*a*d[i]; m[i+1]=t*bb*d[i]; }
    }
    return function(x){
      if(x<=pts[0].x) return pts[0].y;
      if(x>=pts[n-1].x) return pts[n-1].y;
      let i=0; while(i<n-2 && pts[i+1].x<x) i++;
      const dx=x-pts[i].x, hh=h[i];
      const t0=pts[i].y, t1=m[i], t2=(3*d[i]-2*m[i]-m[i+1])/hh, t3=(m[i]+m[i+1]-2*d[i])/(hh*hh);
      return t0+t1*dx+t2*dx*dx+t3*dx*dx*dx;
    };
  }
  const yOf = monotoneSpline(pts);
  // 输出 0.25° 采样表(直接粘贴进 js/map.js 的 LAT_Y)
  const rows = [];
  for (let lat=-41; lat<=62.001; lat+=0.25) rows.push('['+lat.toFixed(2)+','+yOf(lat).toFixed(1)+']');
  console.log('\nLAT_Y 0.25° sample (' + rows.length + ' pts):');
  console.log(rows.join(','));
  // validate: 中国重点城市 + 其它大区代表
  const cities = [
    ['cn','北京',39.904,116.407],['tw','台北',25.033,121.5654],['hk','香港',22.3193,114.1694],
    ['cn','上海',31.2304,121.4737],['cn','广州',23.1291,113.2644],['cn','深圳',22.5431,114.0579],
    ['jp','东京',35.6762,139.6503],['us','洛杉矶',34.0522,-118.2437],['au','悉尼',-33.8688,151.2093],
    ['gb','伦敦',51.51,-0.13],['sg','新加坡',1.3521,103.8198],
  ];
  console.log('\ncity validation (dot inside country bbox?):');
  for (const [id,name,lat,lon] of cities) {
    const g = all[id];
    if (!g) { console.log('  ' + name + ' country missing'); continue; }
    const x = aLon*lon+bLon, y = yOf(lat);
    const ok = (x>=g.x && x<=g.x+g.w && y>=g.y && y<=g.y+g.h) ? 'INSIDE ✓' : 'OUTSIDE ✗';
    console.log('  ' + name.padEnd(4) + ' (' + x.toFixed(1) + ',' + y.toFixed(1) + ')  bbox[y'+g.y.toFixed(0)+'-'+(g.y+g.h).toFixed(0)+'] ' + ok);
  }
  const hk = all.hk;
  console.log('\n香港 strong anchor: hk path center=(' + (hk.x+hk.w/2).toFixed(1) + ',' + (hk.y+hk.h/2).toFixed(1) + ')  vs  proj(' + (aLon*114.1694+bLon).toFixed(1) + ',' + yOf(22.3193).toFixed(1) + ')');
  await b.close();
})();
