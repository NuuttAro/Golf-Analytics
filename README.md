# Carry — golf GPS, strokes gained & a learning caddie

A mobile web app that installs on iPhone (and Android) from the browser — no App Store needed.
Plain ES modules (no build step) served by a small Python server. Accounts, cloud sync,
friends and leaderboards run on Supabase.

## Run locally

```powershell
pip install -r requirements.txt
python server.py                 # http://localhost:8787
```

Optional environment variables:

| Variable | Enables |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Accounts, sync, friends, leaderboards |
| `ANTHROPIC_API_KEY` | Free-form AI caddie answers (Claude) |
| `AI_REQUESTS_PER_HOUR` | Per-player AI limit (default 30) |

## Go live (one time)

1. **Supabase** (free): create a project at supabase.com.
   - SQL Editor → paste [`supabase/schema.sql`](supabase/schema.sql) → Run.
   - Project Settings → API: copy the **Project URL** and the **anon public** key.
   - Authentication → URL Configuration: set **Site URL** to your live address (step 2), so confirmation and password-reset emails link back to the app.
2. **Host the server over HTTPS** — e.g. Render (free): push this folder to a GitHub repo, then Render → New → Blueprint → pick the repo. [`render.yaml`](render.yaml) sets it up; fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `ANTHROPIC_API_KEY` in the dashboard. (Free instances sleep when idle, so the first open after a while takes ~30 s.)
3. **On iPhone:** open the live address in **Safari** → Share → **Add to Home Screen**. Carry opens full-screen with its own icon. Allow location when asked.

## Features

| Tab | What it does |
| --- | --- |
| **Play** | Find courses near you or by name (OpenStreetMap). Satellite map with live front / centre / back distances, tap-to-measure, shot logging with GPS auto-distance, penalties, hole-out. **Set green** for unmapped courses, **Sim GPS** for testing at a desk, one-tap **Yards / Meters**. |
| **Stats** | Strokes gained (off the tee, approach, around green, putting) vs PGA Tour baseline, trend, FIR / GIR / putts, approach SG by distance, putting by length, learned club gapping. Yards / meters toggle. |
| **Caddie** | Chat. On-device answers for club picks, club distances, best/worst rounds, averages and SG; anything else goes to Claude (signed-in players only). |
| **Friends** | Sign up / sign in, add friends by username, accept requests, leaderboards (low round, scoring average, SG total and each SG category, by year or all time), head-to-head comparison, friends' shared rounds shot by shot. |
| **Rounds** | History, scorecards, per-round sharing (friends / only me), settings, sync status, export. |

### Accounts & sync
- Local-first: the app works fully signed out and offline; when signed in, every change syncs in the background (and when the app comes back online / to the foreground).
- Rounds played before signing in are added to the account. Demo rounds are removed on first sign-in.
- Signing out removes that player's synced rounds from the phone (they stay in the account).
- Security: Supabase Row Level Security — players only read/write their own data; friends can read rounds shared with friends; accepting a friend request goes through a function that can only accept requests sent to you. The AI endpoint verifies the Supabase session and rate-limits per player, so nobody else can spend your Claude credits.

### How the caddie learns
- **Distances:** each logged full shot (≥55 y) measures how far that club went — from GPS positions when available, else from the change in distance to the pin. Median and typical range per club, and per lie once there are 3+ shots from it.
- **Outcomes:** clubs that have gained strokes from a similar distance (±15 y, 5+ samples) get a small nudge.
- **Conditions:** wind (≈1 %/mph into, 0.5 %/mph helping) and lie adjust the plays-like distance.

### Notes
- Course data comes from public OpenStreetMap servers, which can be slow; the app races three mirrors and falls back to manual greens.
- iPhone web apps get GPS while the app is open (not in the background) — fine for shot-by-shot use.
- `tools/make_icons.py` regenerates the PNG home-screen icons.
