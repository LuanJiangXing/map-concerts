<div align="center">

# Map Concerts · 现场档案馆

**Community-driven Interactive World Atlas of Live Concerts, Tours, and Performance Archives**

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com/)
[![Database](https://img.shields.io/badge/Database-Cloudflare%20D1-blue.svg)](https://developers.cloudflare.com/d1/)

[**English**](README.md) | [**简体中文**](README_zh.md)

</div>

---

## Overview

**Map Concerts (现场档案馆)** is an open-source, interactive web atlas that documents live musical performances around the world.
It aggregates concert tours, music festivals, fan meetings, and acoustic sessions into a responsive geographic map with video links, setlists, and song timestamps.

- **Live Demo**: [https://map-concerts.com](https://map-concerts.com)

---

## Key Features

- **Interactive World Map**: Clustered city markers show live performance history; clicking a city opens a rich modal with setlists and video embeds.
- **Video Integration & Song Timestamps**: Seamlessly parses Bilibili and YouTube links with automated cover backfill, providing one-click song-by-song setlist navigation.
- **Community Contribution & Review**:
  - Built-in user authentication (PBKDF2-SHA256 salted hashes, zero external OAuth/auth dependencies).
  - Submit new shows, add missing links, or propose revisions to existing events through an edit-draft merge workflow.
  - Interactive reaction emojis (🐐 GOAT, 💀 Killed it, ❤️ Moved, 👎 Flopped, ✅ Attended, ❌ Streamed) and favorites collection.
- **Moderation Dashboard**: Visual administrative review system (`/review`) with draft diffs and audit controls.
- **Ultra-lightweight Full-Stack Architecture**: Runs natively on Cloudflare Workers + D1 database + static assets, with zero client bundling frameworks and sub-second cold starts.

---

## Quick Start (Local Development)

All you need is [Wrangler](https://developers.cloudflare.com/workers/wrangler/):

```bash
# 1. Clone the repository
git clone https://github.com/LuanJiangXing/map-concerts.git
cd map-concerts

# 2. Start local development server (automatically seeds local SQLite D1 database)
npx wrangler dev
```

Visit `http://localhost:8787` in your browser.

> **Initial Administrator**:
> Registering an account with the username specified in `wrangler.toml` (`BOOTSTRAP_ADMIN`, default `admin`) will automatically grant administrator privileges on first creation, unlocking `/review`.

---

## Production Deployment

1. **Create Cloudflare D1 Database**:
   ```bash
   npx wrangler d1 create map-concerts-db
   ```
   Copy the output `database_id` into `wrangler.toml`.

2. **Set Admin Password Secret**:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

3. **Deploy**:
   ```bash
   npx wrangler deploy
   ```

---

## License

Licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](./LICENSE) License.
