from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from collections import deque
from threading import RLock
from pathlib import Path
import json
import random

SIZE = 128
MAX_ANTS = 25
MAX_BATCH = 256
COLORS = 10
PORT = 8000

cells = {}
ants = []
history = deque(maxlen=30000)
revision = 0
moves = 0
lock = RLock()

directions = [
    (1, 0, 0),
    (-1, 0, 0),
    (0, 1, 0),
    (0, -1, 0),
    (0, 0, 1),
    (0, 0, -1)
]

def inside(x, y, z):
    return 0 <= x < SIZE and 0 <= y < SIZE and 0 <= z < SIZE

def encode(x, y, z):
    return (x * SIZE + y) * SIZE + z

def decode(p):
    z = p % SIZE
    p //= SIZE
    y = p % SIZE
    x = p // SIZE
    return x, y, z

def make_ant():
    return {
        "x": SIZE // 2 + random.randint(-3, 3),
        "y": SIZE // 2 + random.randint(-3, 3),
        "z": SIZE // 2 + random.randint(-3, 3),
        "d": random.randrange(6),
        "turns": [random.randrange(6) for _ in range(COLORS)]
    }

def reset():
    global cells, ants, history, revision, moves
    cells = {}
    ants = [make_ant()]
    history = deque(maxlen=30000)
    revision = 0
    moves = 0

def record(x, y, z, color):
    global revision
    p = encode(x, y, z)
    cells[p] = color
    revision += 1
    history.append((revision, p, color))

def tick(count):
    global moves

    for _ in range(count):
        for ant in ants:
            x, y, z = ant["x"], ant["y"], ant["z"]
            p = encode(x, y, z)
            color = (cells.get(p, -1) + 1) % COLORS
            record(x, y, z, color)

            ant["d"] = (ant["d"] + ant["turns"][color] + 1) % 6

            dx, dy, dz = directions[ant["d"]]
            nx, ny, nz = x + dx, y + dy, z + dz

            if not inside(nx, ny, nz):
                valid = [
                    i for i, (vx, vy, vz) in enumerate(directions)
                    if inside(x + vx, y + vy, z + vz)
                ]
                ant["d"] = random.choice(valid)
                dx, dy, dz = directions[ant["d"]]
                nx, ny, nz = x + dx, y + dy, z + dz

            ant["x"], ant["y"], ant["z"] = nx, ny, nz
            moves += 1

def payload(since=None):
    result = {
        "revision": revision,
        "moves": moves,
        "ants": [[a["x"], a["y"], a["z"], a["d"]] for a in ants],
        "voxelCount": len(cells),
        "antCount": len(ants)
    }

    if since is None or since < 0:
        result["snapshot"] = [
            [*decode(p), color] for p, color in cells.items()
        ]
        return result

    if since > revision:
        since = -1

    if history and since < history[0][0] - 1:
        result["snapshot"] = [
            [*decode(p), color] for p, color in cells.items()
        ]
        return result

    changed = {}

    for rev, p, color in history:
        if rev > since:
            changed[p] = color

    result["changes"] = [
        [*decode(p), color] for p, color in changed.items()
    ]
    return result

class Handler(BaseHTTPRequestHandler):
    def send_json(self, data):
        raw = json.dumps(data, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index.html"):
            file = Path("index.html")
            if not file.exists():
                self.send_error(404)
                return
            raw = file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        if self.path.startswith("/api/state"):
            with lock:
                self.send_json(payload())
            return

        self.send_error(404)

    def do_POST(self):
        try:
            body = self.read_body()

            with lock:
                if self.path == "/api/tick":
                    count = max(0, min(MAX_BATCH, int(body.get("count", 0))))
                    since = int(body.get("since", -1))
                    if count:
                        tick(count)
                    self.send_json(payload(since))
                    return

                if self.path == "/api/add":
                    if len(ants) < MAX_ANTS:
                        ants.append(make_ant())
                    self.send_json(payload())
                    return

                if self.path == "/api/remove":
                    if len(ants) > 1:
                        ants.pop()
                    self.send_json(payload())
                    return

                if self.path == "/api/reset":
                    reset()
                    self.send_json(payload())
                    return

            self.send_error(404)

        except Exception as e:
            self.send_json({"error": str(e)})

    def log_message(self, *args):
        pass

reset()

print(f"RGBAnt 3D: http://127.0.0.1:{PORT}")
print(f"World: {SIZE}³ | Maximum positions: {SIZE**3:,}")
print(f"Ants: {MAX_ANTS} | Colors: {COLORS} | Speed cap: {MAX_BATCH}")

ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
