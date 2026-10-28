#!/usr/bin/env python3
"""生成中国内部省界折线数据(public/js/china-province-seams.js)。

数据:阿里 DataV areas_v3 中国省级 GeoJSON(100000_full,大陆标准,台湾即省 710000)。
  源 URL:https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
  用法:python3 build.py [--input cn_prov.json](缺省则按上方 URL 下载)

方法:
  1) 取每个省级要素的全部环(剔除九段线区域 100000_JD)。
  2) 一条边同时被两个省(直辖市/特区同算)的环精确共享(坐标一致)→ 内部省界;
     只属一个省的边 = 海岸/国境,丢弃。
  3) 共享边按端点拼成折线链,投影到世界底图(viewBox 1010×666)坐标后用
     Ramer–Douglas–Peucker 简化(px 容差),再反投影回经纬度,四舍五入输出。
  → 结果只含「大陆内部省界」,不含国境/海岸线,也不含台湾/海南等海岛省界
    (海岛整省环海、无共享边,自然不在列)。

投影复刻 public/js/map.js: x = 2.811304*lng + 474.801355; y = yOfLat(lat) 分段线性表。
输出文件为浏览器全局:window.CHINA_PROVINCE_SEAMS = [[[lng,lat],...],...](polyline 数组);
map.js 渲染时用同一 project() 实时投影成 SVG <path>。
"""
import json, re, sys, os, urllib.request, bisect, math

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(ROOT))  # 本脚本在 <repo>/scripts/china-province-boundaries/
OUT = os.path.join(REPO, 'public', 'js', 'china-province-seams.js')
URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json'
MAPJS = open(os.path.join(REPO, 'public', 'js', 'map.js')).read()

# ---- 复刻 map.js 的 yOfLat(逐字提取该表,单一来源)----
pts = sorted(set((float(a), float(b)) for a, b in re.findall(r'\[([-\d.]+),([-\d.]+)\]', MAPJS)))
lats = [p[0] for p in pts]
def yOfLat(lat):
    if lat <= lats[0]: return pts[0][1]
    if lat >= lats[-1]: return pts[-1][1]
    j = bisect.bisect_left(lats, lat)
    x0, y0 = pts[j-1]; x1, y1 = pts[j]
    return y0 + (y1 - y0) * (lat - x0) / (x1 - x0)
def proj(lng, lat):
    return (2.811304 * lng + 474.801355, yOfLat(lat))
def unproj(x, y):
    # lon 线性可逆;lat 反查分段表
    lng = (x - 474.801355) / 2.811304
    if y <= pts[0][1]: return lng, pts[0][0]
    if y >= pts[-1][1]: return lng, pts[-1][0]
    for j in range(1, len(pts)):
        if pts[j][1] >= y:
            x0, y0 = pts[j-1]; x1, y1 = pts[j]
            lat = x0 + (x1 - x0) * (y - y0) / (y1 - y0)
            return lng, lat
    return lng, pts[-1][0]

def rings_of(f):
    g = f['geometry']
    return g['coordinates'] if g['type'] == 'Polygon' else [r for poly in g['coordinates'] for r in poly]

def rdp(chain_px, tol):
    """Ramer–Douglas–Peucker,输入 px 点列,返回保留点的下标集合。"""
    if len(chain_px) < 3:
        return list(range(len(chain_px)))
    keep = {0, len(chain_px) - 1}
    stack = [(0, len(chain_px) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = chain_px[a], chain_px[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        dmax, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = chain_px[i]
            if L2 == 0:
                d = math.hypot(x - ax, y - ay)
            else:
                t = ((x - ax) * dx + (y - ay) * dy) / L2
                t = max(0.0, min(1.0, t))
                d = math.hypot(x - (ax + t * dx), y - (ay + t * dy))
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol:
            keep.add(idx)
            stack.append((a, idx)); stack.append((idx, b))
    return sorted(keep)

def main():
    argv = sys.argv[1:]
    def get_val(name):
        return argv[argv.index(name) + 1] if name in argv else None
    arg_in = get_val('--input')
    arg_tol = get_val('--tol')
    if arg_in:
        geojson = json.load(open(arg_in))
    else:
        print('downloading', URL)
        req = urllib.request.Request(URL, headers={'User-Agent': 'davidtao-build/1.0'})
        geojson = json.load(urllib.request.urlopen(req, timeout=60))
    feats = [f for f in geojson['features'] if str(f['properties']['adcode']) != '100000_JD']

    seg_owner = {}
    for f in feats:
        ad = str(f['properties']['adcode'])
        for ring in rings_of(f):
            for i in range(len(ring) - 1):
                a = tuple(round(c, 6) for c in ring[i]); b = tuple(round(c, 6) for c in ring[i + 1])
                k = (a, b) if a <= b else (b, a)
                seg_owner.setdefault(k, set()).add(ad)
    seams = [k for k, v in seg_owner.items() if len(v) >= 2]

    # 拼链
    def assemble(segs):
        segs = list(segs); visited = set(); out = []
        while len(visited) < len(segs):
            start = next(s for s in segs if s not in visited)
            adj = {}
            for s in segs:
                if s not in visited:
                    adj.setdefault(s[0], []).append(s); adj.setdefault(s[1], []).append(s)
            path = [start[0], start[1]]; visited.add(start)
            def grow_end(pt):
                while True:
                    opts = [s for s in adj.get(pt, []) if s not in visited]
                    if not opts: return
                    s = opts[0]; visited.add(s)
                    np = s[1] if s[0] == pt else s[0]
                    if np == path[0]: path.append(np); return
                    path.append(np); pt = np
            def grow_start(pt):
                while True:
                    opts = [s for s in adj.get(pt, []) if s not in visited]
                    if not opts: return
                    s = opts[0]; visited.add(s)
                    np = s[0] if s[1] == pt else s[1]
                    if np == path[-1]: return
                    path.insert(0, np); pt = np
            grow_end(start[1]); grow_start(start[0])
            out.append(path)
        return out
    chains_ll = assemble(seams)

    # 简化:默认关(满分辨率,放大至 16× 仍顺滑,与 DataV 官网一致)。
    # 若要瘦身可给 --tol 0.2(px 容差);注意 ZOOM_MAX=16 时 0.4px 容差会放大成 ~6px 折角(曾致用户嫌粗糙)。
    TOL = float(arg_tol) if arg_tol else 0.0
    out = []
    for chain in chains_ll:
        px = [proj(lng, lat) for (lng, lat) in chain]
        keep = rdp(px, TOL) if TOL > 0 else list(range(len(px)))
        pl = [tuple(round(v, 4) for v in chain[i]) for i in keep]
        # 去连续重复点
        ded = []
        for p in pl:
            if not ded or p != ded[-1]:
                ded.append(p)
        if len(ded) >= 2:
            out.append(ded)
    out.sort(key=len, reverse=True)

    js = '/* 中国内部省界折线(自动生成,勿手改)——见 scripts/china-province-boundaries/build.py\n' \
         ' * 数据源:阿里 DataV areas_v3 100000_full(大陆标准)。仅大陆内部省界,不含国境/海岸/海岛省界。\n' \
         ' * 单位:经纬度 [lng,lat];map.js 渲染时用 project() 投影。 */\n' \
         'window.CHINA_PROVINCE_SEAMS = ' + json.dumps(out, separators=(',', ':')) + ';\n'
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, 'w').write(js)
    print('seams chains:', len(out), 'pts(total):', sum(len(c) for c in out), 'file bytes:', len(js))

if __name__ == '__main__':
    main()
