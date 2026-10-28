<div align="center">

# 🗺️ 现场档案馆 · Map Concerts

**社区共建的交互式音乐现场与巡回演唱会世界地图档案**

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com/)
[![Database](https://img.shields.io/badge/Database-Cloudflare%20D1-blue.svg)](https://developers.cloudflare.com/d1/)

[**English**](README.md) | [**简体中文**](README_zh.md)

</div>

---

## 📌 概述

**现场档案馆 (Map Concerts)** 是一个面向音乐爱好者与现场演出纪录的开源互动地图档案系统。
全纪录歌手的巡回演唱会、音乐节、歌友会及现场视频、曲目单与时点跳转。

- 🌐 **在线预览**: [https://map-concerts.com](https://map-concerts.com)

---

## ✨ 核心特性

- 🗺️ **交互式世界地图**: 城市点位聚合现场演出，点击弹窗即可浏览场次详情、视频封面与曲目单。
- 🎬 **视频与时间轴**: 支持 Bilibili / YouTube 视频解析与封面懒填，提供逐曲时间轴（Setlist）一键跳转。
- 🤝 **社区共建体系**:
  - 用户注册/登录（自包含用户名+PBKDF2 加盐哈希密码，零外部依赖）。
  - 提交演出、补充链接与提出「建议修改」（草稿-合并机制）。
  - 6 款反应 Emoji 互动（🐐封神、💀秒了、❤️感动、👎翻车、✅在场、❌云过）与演出收藏。
- 🛡️ **管理员审核后台**: 针对提交与草稿提供可视化多维度审核与合并系统。
- ⚡ **超轻量全栈架构**: 基于 Cloudflare Workers + D1 + 原生静态资源，无大型前端打包框架，秒级冷启动。

---

## 🚀 快速开始 (本地开发)

本项目只需安装 [Wrangler](https://developers.cloudflare.com/workers/wrangler/):

```bash
# 1. 克隆仓库
git clone https://github.com/LuanJiangXing/map-concerts.git
cd map-concerts

# 2. 本地启动 (自动创建本地 SQLite 并在冷启动时填充初始种子数据)
npx wrangler dev
```

打开浏览器访问 `http://localhost:8787` 即可体验全部功能！

> 💡 **初始管理员账号**:
> 注册用户名若与 `wrangler.toml` 中的 `BOOTSTRAP_ADMIN` 一致（默认 `admin`），该账号在首次创建时将自动提权为系统管理员，并解锁 `/review` 审核后台。

---

## 🛠️ 项目结构

```
map-concerts/
├── public/                 # 静态前端资源 (Worker 直接下发)
│   ├── index.html          # 首页: 歌手卡片索引
│   ├── singer.html         # 歌手地图页
│   ├── submit.html         # 提交演出 / 建议修改页
│   ├── my-submissions.html # 我的提交管理
│   ├── profile.html        # 个人中心
│   ├── review.html         # 管理员审核后台
│   ├── css/style.css       # 设计系统样式
│   └── js/                 # 地图引擎、弹窗、音频时轴与业务模块
├── src/                    # Cloudflare Worker 后端 API
│   ├── index.js            # Worker 路由入口与安全响应头中间件
│   ├── db.js               # D1 自动建表 (ensureSchema) 与通用辅助
│   ├── auth.js             # 用户系统 (PBKDF2 加密/会话/CSRF/限流)
│   ├── performances.js     # 演出数据查询与聚合
│   ├── submissions.js      # 提交与草稿管理
│   ├── review.js           # 审核后台与草稿合并
│   └── video-meta.js       # 视频元数据与封面通道
├── wrangler.toml           # Cloudflare Worker / D1 / 资源配置
├── schema.sql              # 数据库 DDL 表结构参考
└── seed.sql                # 示例演出种子数据
```

---

## ☁️ 生产部署

1. **创建 Cloudflare D1 数据库**:
   ```bash
   npx wrangler d1 create map-concerts-db
   ```
   并将生成的 `database_id` 填入 `wrangler.toml`。

2. **配置审核密码**:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

3. **一键部署**:
   ```bash
   npx wrangler deploy
   ```

---

## 📄 开源协议 (License)

本项目采用 [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](./LICENSE) 协议开源。

- **署名 (Attribution)**: 必须保留原作者署名。
- **非商业性使用 (NonCommercial)**: 不得用于商业目的。
- **相同方式共享 (ShareAlike)**: 基于本项目的二次衍生创作必须以相同协议共享。
