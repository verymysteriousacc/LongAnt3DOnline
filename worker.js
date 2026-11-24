
const SIZE = 128
const MAX_ANTS = 25
const MAX_BATCH = 256
const COLORS = 10
const MAX_CHAT = 180

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" }
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === "/api/health") {
      return json({
        online: true,
        world: [SIZE, SIZE, SIZE],
        maxAnts: MAX_ANTS,
        colors: COLORS,
        chat: true
      })
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,12})$/)

    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "WebSocket required" }, 426)
      }

      const id = env.ROOMS.idFromName(match[1].toUpperCase())
      return env.ROOMS.get(id).fetch(request)
    }

    return env.ASSETS.fetch(request)
  }
}

export class Room {
  constructor(ctx) {
    this.ctx = ctx
    this.sql = ctx.storage.sql
    this.cells = new Map()
    this.players = new Map()
    this.lastChat = new Map()
    this.moves = 0

    this.sql.exec("CREATE TABLE IF NOT EXISTS cells (id INTEGER PRIMARY KEY, color INTEGER NOT NULL)")
    this.sql.exec("CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, direction INTEGER NOT NULL, color INTEGER NOT NULL, name TEXT NOT NULL, tag TEXT NOT NULL DEFAULT 'ANT-000000')")
    this.sql.exec("CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, moves INTEGER NOT NULL)")
    this.sql.exec("CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)")

    try {
      this.sql.exec("ALTER TABLE players ADD COLUMN tag TEXT NOT NULL DEFAULT 'ANT-000000'")
    } catch {}

    this.ready = ctx.blockConcurrencyWhile(async () => {
      for (const row of this.sql.exec("SELECT id, color FROM cells").toArray()) {
        this.cells.set(row.id, row.color)
      }

      for (const row of this.sql.exec("SELECT id, x, y, z, direction, color, name, tag FROM players").toArray()) {
        this.players.set(row.id, {
          id: row.id,
          x: row.x,
          y: row.y,
          z: row.z,
          direction: row.direction,
          color: row.color,
          name: row.name,
          tag: row.tag
        })
      }

      const row = this.sql.exec("SELECT moves FROM metadata WHERE id = 1").toArray()[0]
      this.moves = row?.moves ?? 0
    })
  }

  key(x, y, z) {
    return (x * SIZE + y) * SIZE + z
  }

  savePlayer(p) {
    this.sql.exec(
      "INSERT OR REPLACE INTO players (id, x, y, z, direction, color, name, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      p.id, p.x, p.y, p.z, p.direction, p.color, p.name, p.tag
    )
  }

  ants() {
    return [...this.players.values()]
  }

  chatHistory() {
    return this.sql.exec(
      "SELECT tag, message, created_at FROM chat ORDER BY id DESC LIMIT 40"
    ).toArray().reverse()
  }

  send(ws, data) {
    try {
      ws.send(JSON.stringify(data))
    } catch {}
  }

  broadcast(data) {
    const message = JSON.stringify(data)

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message)
      } catch {}
    }
  }

  driverId() {
    const sockets = this.ctx.getWebSockets()
    return sockets[0]?.deserializeAttachment()?.id ?? null
  }

  broadcastDriver() {
    this.broadcast({
      type: "driver",
      playerId: this.driverId()
    })
  }

  async fetch(request) {
    await this.ready

    if (this.players.size >= MAX_ANTS) {
      return json({ error: "Room is full", maxAnts: MAX_ANTS }, 409)
    }

    const url = new URL(request.url)
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    const id = crypto.randomUUID()
    const tag = "ANT-" + crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()
    const color = this.players.size % COLORS

    const player = {
      id,
      x: Math.floor(Math.random() * SIZE),
      y: Math.floor(Math.random() * SIZE),
      z: Math.floor(Math.random() * SIZE),
      direction: Math.floor(Math.random() * 6),
      color,
      name: tag,
      tag
    }

    this.players.set(id, player)
    this.savePlayer(player)

    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ id })

    this.send(server, {
      type: "welcome",
      playerId: id,
      tag,
      size: SIZE,
      colors: COLORS,
      driver: this.driverId() === id,
      ants: this.ants(),
      cells: [...this.cells.entries()],
      moves: this.moves,
      voxelCount: this.cells.size,
      chat: this.chatHistory()
    })

    this.broadcast({
      type: "ants",
      ants: this.ants()
    })

    this.broadcast({
      type: "system",
      message: tag + " joined the room"
    })

    this.broadcastDriver()

    return new Response(null, {
      status: 101,
      webSocket: client
    })
  }

  async webSocketMessage(ws, message) {
    await this.ready

    let data

    try {
      data = JSON.parse(message)
    } catch {
      return
    }

    const attachment = ws.deserializeAttachment()

    if (!attachment?.id) return

    const player = this.players.get(attachment.id)

    if (!player) return

    if (data.type === "chat") {
      const now = Date.now()
      const previous = this.lastChat.get(attachment.id) || 0

      if (now - previous < 700) return

      const messageText = String(data.message || "").trim().slice(0, MAX_CHAT)

      if (!messageText) return

      this.lastChat.set(attachment.id, now)

      const entry = {
        tag: player.tag,
        message: messageText,
        created_at: now
      }

      this.sql.exec(
        "INSERT INTO chat (tag, message, created_at) VALUES (?, ?, ?)",
        entry.tag,
        entry.message,
        entry.created_at
      )

      this.sql.exec(
        "DELETE FROM chat WHERE id NOT IN (SELECT id FROM chat ORDER BY id DESC LIMIT 40)"
      )

      this.broadcast({
        type: "chat",
        entry
      })

      return
    }

    if (data.type === "reset") {
      if (attachment.id !== this.driverId()) return

      this.cells.clear()
      this.moves = 0

      this.sql.exec("DELETE FROM cells")

      for (const p of this.players.values()) {
        p.x = Math.floor(Math.random() * SIZE)
        p.y = Math.floor(Math.random() * SIZE)
        p.z = Math.floor(Math.random() * SIZE)
        p.direction = Math.floor(Math.random() * 6)
        this.savePlayer(p)
      }

      this.sql.exec(
        "INSERT OR REPLACE INTO metadata (id, moves) VALUES (1, 0)"
      )

      this.broadcast({
        type: "reset",
        ants: this.ants(),
        moves: 0,
        voxelCount: 0
      })

      return
    }

    if (data.type !== "tick") return
    if (attachment.id !== this.driverId()) return

    const count = Math.max(
      1,
      Math.min(MAX_BATCH, Math.floor(Number(data.count) || 1))
    )

    const changed = new Map()

    for (let step = 0; step < count; step++) {
      for (const p of this.players.values()) {
        const key = this.key(p.x, p.y, p.z)
        const color = ((this.cells.get(key) ?? -1) + 1) % COLORS

        this.cells.set(key, color)
        changed.set(key, color)

        p.direction = Math.floor(Math.random() * 6)

        if (p.direction === 0) p.x++
        if (p.direction === 1) p.x--
        if (p.direction === 2) p.y++
        if (p.direction === 3) p.y--
        if (p.direction === 4) p.z++
        if (p.direction === 5) p.z--

        p.x = (p.x + SIZE) % SIZE
        p.y = (p.y + SIZE) % SIZE
        p.z = (p.z + SIZE) % SIZE
      }
    }

    this.moves += count * this.players.size

    for (const p of this.players.values()) {
      this.savePlayer(p)
    }

    for (const [key, color] of changed) {
      this.sql.exec(
        "INSERT OR REPLACE INTO cells (id, color) VALUES (?, ?)",
        key,
        color
      )
    }

    this.sql.exec(
      "INSERT OR REPLACE INTO metadata (id, moves) VALUES (1, ?)",
      this.moves
    )

    this.broadcast({
      type: "update",
      cells: [...changed.entries()],
      ants: this.ants(),
      moves: this.moves,
      voxelCount: this.cells.size
    })
  }

  async webSocketClose(ws) {
    await this.ready

    const attachment = ws.deserializeAttachment()

    if (!attachment?.id) return

    const player = this.players.get(attachment.id)

    if (!player) return

    this.players.delete(attachment.id)
    this.lastChat.delete(attachment.id)
    this.sql.exec("DELETE FROM players WHERE id = ?", attachment.id)

    this.broadcast({
      type: "system",
      message: player.tag + " left the room"
    })

    this.broadcast({
      type: "ants",
      ants: this.ants()
    })

    this.broadcastDriver()
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws)
  }
      }
      
