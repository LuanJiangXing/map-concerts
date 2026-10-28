#!/usr/bin/env python3
"""⚠ 已回滚(2026-09-03):勿用本脚本重建线上 world.svg。

本脚本(高分辨率世界底图重建:Natural Earth 1:10m + DataV 中国)曾上线,因底图纬度投影表
(map.js yOfLat)仅 -41°..62°,高纬靠旧图锚点补表导致挪威中部等区域被压变形/失真,已回滚;
生产 world.svg 维持原 @svg-maps/world。仅保留此脚本作研究参考;除非彻底复核投影,否则勿重建。

==========================================================================================
重建世界底图 public/images/world.svg —— 全国界线提升到高分辨率,并保证中国国界大陆标准正确。

数据:
  - 中国(及港澳台、南海诸岛):阿里 DataV areas_v3 100000_full(大陆标准,藏南/阿克赛钦归中)。
    取 34 个省级要素(剔除 100000_JD 九段线区域)做 union → 中国整体(含港澳台岛屿/南海诸岛子路径)。
    注意:香港 HKG/澳门 MAC/台湾 TWN 在 Natural Earth 是独立要素,必须从 NE 层剔除,由中国覆盖。
  - 其它国家:Natural Earth ne_10m_admin_0_countries(public domain),剔除 CHN/HKG/TWN/MAC;
    与中国 bbox 相交的要素先 difference(China),使可见国界 = DataV 中国线,避免两源 1px 出入露缝。

流程:
  1) 复刻 map.js 投影(x=2.811304*lng+474.801355;y=yOfLat 分段表,从 map.js 正则逐字提取)。
  2) 拓扑操作(union/difference)在经纬度空间做;最后逐点投影到 px,px 空间 RDP 简化。
  3) 输出:所有 NE 国家 path(id=ADM0_A3)在前 → 中国 path(id="cn",多子路径)最后压顶
     → 原有 nine-dash-line 元素原样拷贝(置于最顶层)。

用法:
  python3 build.py --ne /path/ne_10m_admin_0_countries.geojson --cn /path/cn_prov.json [--tol 0.15]
  缺省输入:自动按文件内 URL 下载。
输出覆盖 <repo>/public/images/world.svg。
"""
import json, re, os, sys, bisect, math, urllib.request
from shapely.geometry import shape, box, MultiPolygon, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.validation import make_valid

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(ROOT))
OUT = os.path.join(REPO, 'public', 'images', 'world.svg')
NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'
CN_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json'
OLD_SVG = open(OUT).read()  # 用于提取 nine-dash-line 原样元素

# ---- 投影。核心:复刻 map.js 的 yOfLat 表(-41°..62°,逐字提取,勿手抄),再按
# 旧底图真实纬向锚点把表**双向延长**到地图实际覆盖(约 -60°S..84°N),供世界重建用。
# 注意:延长只作用于表覆盖范围之外;范围内严格等于 map.js 表 → 中国/省界/城市点位置零影响。
# 锚点来自旧底图(@svg-maps/world)各国顶部像素 ↔ Natural Earth 同国最北纬 / 底像素 ↔ 最南纬
# (2026-09-03 实测;旧图无南极洲,画布顶≈84N(y≈0)、底≈60S(y≈666),北侧 y<0 自然裁掉)。
NORTH_ANCHORS = [(83.6, 0.2), (83.1, 12.1), (81.9, 39.1), (71.4, 172.9), (70.1, 184.2), (69.0, 192.6), (66.6, 211.3)]
SOUTH_ANCHORS = [(-59.5, 665.5), (-55.9, 652.0), (-55.1, 647.8), (-54.8, 646.4), (-52.6, 636.1), (-49.7, 623.4), (-47.0, 611.8)]

MAPJS = open(os.path.join(REPO, 'public', 'js', 'map.js')).read()
pts = sorted(set((float(a), float(b)) for a, b in re.findall(r'\[([-\d.]+),([-\d.]+)\]', MAPJS)))
knots = sorted(set([(round(a, 2), b) for (a, b) in pts] + [(round(a, 2), b) for a, b in NORTH_ANCHORS] + [(round(a, 2), b) for a, b in SOUTH_ANCHORS]))
kts_lat = [k[0] for k in knots]
def yBuild(lat):
    if lat <= kts_lat[0]: return knots[0][1] + (lat - kts_lat[0]) * (knots[1][1] - knots[0][1]) / (kts_lat[1] - kts_lat[0])
    if lat >= kts_lat[-1]: return knots[-1][1] + (lat - kts_lat[-1]) * (knots[-1][1] - knots[-2][1]) / (kts_lat[-1] - kts_lat[-2])
    j = bisect.bisect_left(kts_lat, lat)
    x0, y0 = knots[j-1]; x1, y1 = knots[j]
    return y0 + (y1 - y0) * (lat - x0) / (x1 - x0)
def proj(lng, lat):
    return (2.811304 * lng + 474.801355, yBuild(lat))

def rdp(px, tol):
    if len(px) < 3:
        return list(range(len(px)))
    keep = {0, len(px) - 1}; stack = [(0, len(px) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = px[a]; bx, by = px[b]
        dx, dy = bx - ax, by - ay; L2 = dx*dx + dy*dy
        dmax, idx = 0.0, -1
        for i in range(a+1, b):
            x, y = px[i]
            if L2 == 0:
                d = math.hypot(x - ax, y - ay)
            else:
                t = max(0.0, min(1.0, ((x-ax)*dx + (y-ay)*dy)/L2))
                d = math.hypot(x - (ax+t*dx), y - (ay+t*dy))
            if d > dmax: dmax, idx = d, i
        if dmax > tol:
            keep.add(idx); stack.append((a, idx)); stack.append((idx, b))
    return sorted(keep)

def norm(geom):
    """统一取向:每个 Polygon 外环 CCW、内环 CW → nonzero fill 正确(多岛填充、湖洞镂空)。"""
    if isinstance(geom, Polygon):
        return orient(geom, sign=1.0)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([orient(p, sign=1.0) for p in geom.geoms])
    return geom

def geom_rings(geom):
    """返回 (lon,lat) 环列表;输入需已 norm()(外环 CCW、内环 CW)。"""
    if isinstance(geom, Polygon):
        polys = [geom]
    elif isinstance(geom, MultiPolygon):
        polys = list(geom.geoms)
    else:
        return []
    out = []
    for poly in polys:
        out.append(list(poly.exterior.coords))
        for i in poly.interiors:
            out.append(list(i.coords))
    return out

def ring_to_d(ring, tol, drop_thr):
    px = [proj(lng, lat) for (lng, lat) in ring]
    if len(px) < 3: return None
    xs = [p[0] for p in px]; ys = [p[1] for p in px]
    w = max(xs) - min(xs); h = max(ys) - min(ys)
    if w < drop_thr and h < drop_thr:
        return None  # 屏幕上过小(<drop px),省略减少噪音/体积
    keep = rdp(px, tol)
    pxk = [px[i] for i in keep]
    d = 'M' + ''.join(' %.2f,%.2f' % (pxk[i][0], pxk[i][1]) for i in range(len(pxk))) + 'Z'
    return d

def poly_to_d(geom, tol, drop_thr):
    parts = []
    for ring in geom_rings(geom):
        d = ring_to_d(ring, tol, drop_thr)
        if d: parts.append(d)
    return ''.join(parts)

def load(url):
    print('download', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'davidtao-build/1.0'})
    return json.load(urllib.request.urlopen(req, timeout=180))

def main():
    argv = sys.argv[1:]
    def val(name): return argv[argv.index(name)+1] if name in argv else None
    ne_p = val('--ne'); cn_p = val('--cn')
    tol = float(val('--tol')) if val('--tol') else 0.15
    drop = float(val('--drop')) if val('--drop') else 0.35
    ne = json.load(open(ne_p)) if ne_p else load(NE_URL)
    cn = json.load(open(cn_p)) if cn_p else load(CN_URL)
    print('tol=%.3fpx drop>=%.2fpx' % (tol, drop))

    # ---- 中国 union(大陆标准,含港澳台/南海诸岛)----
    cn_geoms = []
    for f in cn['features']:
        if str(f['properties'].get('adcode')) == '100000_JD':
            continue
        g = shape(f['geometry'])
        g = make_valid(g)
        if g.geom_type == 'Polygon': cn_geoms.append(g)
        elif g.geom_type == 'MultiPolygon': cn_geoms.extend(list(g.geoms))
        elif g.geom_type == 'GeometryCollection':
            for sub in g.geoms:
                if sub.geom_type == 'Polygon': cn_geoms.append(sub)
                elif sub.geom_type == 'MultiPolygon': cn_geoms.extend(list(sub.geoms))
    china = norm(unary_union(cn_geoms))
    print('China union type:', china.geom_type, 'rings est:', len(geom_rings(china)))
    cb = china.bounds  # minx,miny,maxx,maxy

    # ---- Natural Earth 其它国家 ----
    EXCLUDE = {'CHN', 'HKG', 'TWN', 'MAC', 'ATA'}  # ATA=南极洲(旧底图无)
    china_shape = china
    china_bbox = box(*cb).buffer(0.05)
    lands = []   # (id, d, rings_wanted) 仅保留 d 非空
    for f in ne['features']:
        p = f['properties']
        ad = p.get('ADM0_A3') or p.get('ISO_A3_EH')
        if ad in EXCLUDE: continue
        g = shape(f['geometry'])
        if g.is_empty: continue
        if g.geom_type not in ('Polygon', 'MultiPolygon'): continue
        # 与中国相交者裁掉中国部分 → 国界贴 DataV 中国线(大陆标准)
        if china_bbox.intersects(g):
            g = g.difference(china_shape)
            if g.is_empty or g.geom_type not in ('Polygon', 'MultiPolygon'): continue
            g = norm(g)
        d = poly_to_d(g, tol, drop)
        if d:
            lands.append((ad, d))
    print('NE lands emitted:', len(lands))

    # ---- 中国 path(不简化)----
    china_d = poly_to_d(china, 0.0, 0.1)  # 满分辨率,仅丢 <0.1px 环
    print('china_d chars:', len(china_d))

    # ---- 原 nine-dash-line 元素原样 ----
    m = re.search(r'<path[^>]*class="[^"]*nine-dash-line[^"]*"[^>]*>', OLD_SVG, re.S)
    nine = m.group(0) if m else ''
    print('nine-dash element found:', bool(nine))

    body = []
    for ad, d in lands:
        body.append('<path id="%s" d="%s"/>' % (ad, d))
    body.append('<path id="cn" d="%s"/>' % china_d)
    if nine:
        body.append(nine)
    svg = ('<svg\n\txmlns="http://www.w3.org/2000/svg"\n\tviewBox="0 0 1010 666"\n'
           '\taria-label="Map of World"\n\tfill="#d8cfbd"\n>' + ''.join(body) + '\n</svg>')
    open(OUT, 'w').write(svg)
    print('written', OUT, len(svg), 'bytes')

if __name__ == '__main__':
    main()
