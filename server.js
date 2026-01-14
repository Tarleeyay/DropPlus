const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(express.json());

// ================= CONFIG =================
const PORT = 3000;
const POINTS_PER_BOTTLE = 10;

// Simple device auth (change if you want)
const DEVICES = {
  "BIN-01": { api_key: "BIN01SECRET" }
};

// ================= DATABASE =================
const db = new sqlite3.Database("./recycle.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      school_id TEXT PRIMARY KEY,
      name TEXT,
      points INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      bottle_count INTEGER NOT NULL,
      points_added INTEGER NOT NULL,
      device_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

// ================= STATIC WEBSITE =================
app.use(express.static(path.join(__dirname, "public")));

// ================= HELPERS =================
function authDevice(device_id, api_key) {
  return DEVICES[device_id] && DEVICES[device_id].api_key === api_key;
}

// ================= API FOR ESP32 =================
app.post("/api/deposit", (req, res) => {
  const { school_id, bottle_count, device_id, api_key } = req.body || {};

  if (!school_id || typeof school_id !== "string") {
    return res.status(400).json({ ok: false, error: "Missing school_id" });
  }

  if (!Number.isInteger(bottle_count) || bottle_count <= 0) {
    return res.status(400).json({ ok: false, error: "bottle_count must be integer > 0" });
  }

  if (!device_id || !api_key || !authDevice(device_id, api_key)) {
    return res.status(401).json({ ok: false, error: "Device auth failed" });
  }

  const points_added = bottle_count * POINTS_PER_BOTTLE;

  db.serialize(() => {
    // create user if not exists
    db.run(`INSERT OR IGNORE INTO users (school_id, points) VALUES (?, 0)`, [school_id]);

    // add points
    db.run(`UPDATE users SET points = points + ? WHERE school_id = ?`,
      [points_added, school_id]
    );

    // log transaction
    db.run(`
      INSERT INTO transactions (school_id, bottle_count, points_added, device_id)
      VALUES (?, ?, ?, ?)
    `, [school_id, bottle_count, points_added, device_id]);

    // return updated total
    db.get(`SELECT school_id, points FROM users WHERE school_id = ?`,
      [school_id],
      (err, row) => {
        if (err) return res.status(500).json({ ok: false, error: "DB error" });
        res.json({
          ok: true,
          school_id: row.school_id,
          points_added,
          total_points: row.points
        });
      }
    );
  });
});

// ================= LEADERBOARD =================
app.get("/api/leaderboard", (req, res) => {
  db.all(
    `
    SELECT 
      u.school_id,
      u.name,
      u.points,
      IFNULL(SUM(t.bottle_count), 0) AS bottles_total
    FROM users u
    LEFT JOIN transactions t ON t.school_id = u.school_id
    GROUP BY u.school_id
    ORDER BY bottles_total DESC, u.points DESC
    LIMIT 20
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: "DB error" });
      res.json({ ok: true, leaderboard: rows });
    }
  );
});

// ================= USER INFO =================
app.get("/api/user/:school_id", (req, res) => {
  const { school_id } = req.params;

  db.get(
    `
    SELECT 
      u.school_id,
      u.name,
      u.points,
      IFNULL(SUM(t.bottle_count), 0) AS bottles_total
    FROM users u
    LEFT JOIN transactions t ON t.school_id = u.school_id
    WHERE u.school_id = ?
    GROUP BY u.school_id
    `,
    [school_id],
    (err, row) => {
      if (err) return res.status(500).json({ ok: false, error: "DB error" });
      if (!row) return res.status(404).json({ ok: false, error: "User not found" });
      res.json({ ok: true, user: row });
    }
  );
});

// ================= USER TRANSACTIONS =================
app.get("/api/user/:school_id/transactions", (req, res) => {
  const { school_id } = req.params;

  db.all(
    `
    SELECT id, bottle_count, points_added, device_id, created_at
    FROM transactions
    WHERE school_id = ?
    ORDER BY id DESC
    LIMIT 30
    `,
    [school_id],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: "DB error" });
      res.json({ ok: true, transactions: rows });
    }
  );
});
// ================= ADMIN RESET =================
const ADMIN_KEY = "RESET123"; // change if you want

app.post("/api/admin/reset", (req, res) => {
  const { key } = req.body || {};
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  db.serialize(() => {
    db.run("DELETE FROM transactions");
    db.run("UPDATE users SET points = 0");
    res.json({ ok: true });
  });
});

// ================= START SERVER =================
app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log(" DropPlus+ Server Running ");
  console.log(` Open on laptop: http://localhost:${PORT}`);
  console.log("======================================");
});

