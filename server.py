"""Carry — local server.

Serves the mobile web app from ./public and exposes one endpoint for the
AI caddie's free-form questions. The Claude API key never reaches the
browser: the Anthropic SDK resolves credentials from ANTHROPIC_API_KEY
(or an `ant auth login` profile) on this machine.

Run:  python server.py            -> http://localhost:8787
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _load_dotenv():
    """Read KEY=value lines from .env next to this file (local dev only; hosts set real env vars)."""
    path = Path(__file__).parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()
PORT = int(os.environ.get("PORT", "8787"))
PUBLIC = Path(__file__).parent / "public"
MODEL = "claude-opus-5-5"

# Accounts (optional). The anon key is public by design; Row Level Security in
# supabase/schema.sql is what protects the data.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
AI_PER_HOUR = int(os.environ.get("AI_REQUESTS_PER_HOUR", "30"))
_usage = {}  # user id -> list of request timestamps
_auth_cache = {}  # token -> (user id, expires)


def verify_user(auth_header):
    """Return the Supabase user id for a bearer token, or None."""
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:].strip()
    now = time.time()
    hit = _auth_cache.get(token)
    if hit and hit[1] > now:
        return hit[0]
    req = urllib.request.Request(f"{SUPABASE_URL}/auth/v1/user",
                                 headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            uid = json.load(r).get("id")
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None
    if uid:
        if len(_auth_cache) > 5000:
            _auth_cache.clear()
        _auth_cache[token] = (uid, now + 300)
    return uid


def rate_limited(uid):
    now = time.time()
    hits = [t for t in _usage.get(uid, []) if t > now - 3600]
    if len(hits) >= AI_PER_HOUR:
        _usage[uid] = hits
        return True
    hits.append(now)
    _usage[uid] = hits
    return False

SYSTEM = """You are Carry, an on-course golf caddie inside a mobile stats app.
You get the player's own data as JSON: club distances learned from their logged
shots, strokes-gained averages by category (vs a PGA Tour baseline), and round
history. Answer the player's question from that data.

Rules:
- Ground every number in the supplied data. If the data can't answer it, say so
  and say what they would need to log.
- Club advice: use the player's own median distances, not tour averages. Adjust
  for lie, wind and elevation if mentioned, and name one backup club.
- Distances are in the unit given in data.units.
- Keep answers short enough to read between shots: 1-4 sentences, or a small
  list when asked for several items. No preamble."""

_client = None


def get_client():
    global _client
    if _client is None:
        import anthropic  # imported lazily so the app runs without it

        _client = anthropic.Anthropic()
    return _client


def ai_available():
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                or os.environ.get("ANTHROPIC_PROFILE") or Path.home().joinpath(".config", "anthropic").exists())


def ask_claude(question, context, history):
    import anthropic

    messages = []
    for turn in history[-6:]:
        role = "assistant" if turn.get("role") == "caddie" else "user"
        text = str(turn.get("text", ""))[:2000]
        if text:
            if messages and messages[-1]["role"] == role:
                messages[-1]["content"] += "\n" + text
            else:
                messages.append({"role": role, "content": text})
    if messages and messages[0]["role"] == "assistant":
        messages.pop(0)
    user = f"<player_data>\n{json.dumps(context, separators=(',', ':'))}\n</player_data>\n\n{question}"
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"] += "\n" + user
    else:
        messages.append({"role": "user", "content": user})

    try:
        resp = get_client().beta.messages.create(
            model=MODEL,
            max_tokens=2000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low"},
            system=SYSTEM,
            messages=messages,
        )
    except anthropic.AuthenticationError:
        return 503, {"error": "No valid Claude API credentials on the server."}
    except anthropic.RateLimitError:
        return 429, {"error": "Caddie is busy (rate limited). Try again in a moment."}
    except anthropic.APIStatusError as e:
        return 502, {"error": f"Claude API error ({e.status_code})."}
    except anthropic.APIConnectionError:
        return 502, {"error": "Couldn't reach the Claude API."}

    if resp.stop_reason == "refusal":
        return 200, {"answer": "I can't help with that one — ask me about your game."}
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    return 200, {"answer": text or "No answer."}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            return self._json(200, {"ai": ai_available(), "model": MODEL, "accounts": bool(SUPABASE_URL)})
        if self.path == "/config.js":
            body = ("export default " + json.dumps({"supabaseUrl": SUPABASE_URL, "supabaseAnonKey": SUPABASE_ANON_KEY}) + ";\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/caddie":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 200_000:
                return self._json(413, {"error": "too large"})
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "bad json"})
        question = str(data.get("question", "")).strip()[:1000]
        if not question:
            return self._json(400, {"error": "empty question"})
        if not ai_available():
            return self._json(503, {"error": "AI caddie not configured on the server."})
        if SUPABASE_URL:  # accounts on: only signed-in players may spend API credits
            uid = verify_user(self.headers.get("Authorization", ""))
            if not uid:
                return self._json(401, {"error": "Sign in to use the AI caddie."})
            if rate_limited(uid):
                return self._json(429, {"error": f"You've reached {AI_PER_HOUR} AI questions this hour. Try again later."})
        code, payload = ask_claude(question, data.get("context", {}), data.get("history", []))
        return self._json(code, payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    print(f"Carry running at http://localhost:{PORT}  (AI caddie: {'on' if ai_available() else 'off'})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
