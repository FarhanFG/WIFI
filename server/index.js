const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const archiver = require("archiver");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "..");
const UPLOAD_DIR = path.join(ROOT, "oupload");
const TMP_DIR = path.join(ROOT, ".upload_tmp");
const ZIP_DIR = path.join(ROOT, "zips");
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

for (const dir of [UPLOAD_DIR, TMP_DIR, ZIP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function localIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem}_${i}${ext}`);
    i += 1;
  }
  return dest;
}

function safeRelPath(raw) {
  const cleaned = String(raw || "upload.bin").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = cleaned.split("/").filter((p) => p && p !== "." && p !== "..");
  return parts.length ? path.join(...parts) : `file_${Date.now()}`;
}

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_FILE_SIZE },
});

app.get("/api/info", (_req, res) => {
  res.json({
    ip: localIp(),
    port: PORT,
    maxFileSize: MAX_FILE_SIZE,
    uploadDir: UPLOAD_DIR,
  });
});

app.get("/api/exists", (req, res) => {
  const rel = safeRelPath(req.query.filename || "");
  const dest =
    path.dirname(rel) === "."
      ? path.join(UPLOAD_DIR, path.basename(rel))
      : path.join(UPLOAD_DIR, rel);
  res.json({ exists: fs.existsSync(dest), path: path.relative(UPLOAD_DIR, dest) });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file received" });
    }
    try {
      const rel = safeRelPath(req.body.filename || req.file.originalname);
      const finalDir =
        path.dirname(rel) === "." ? UPLOAD_DIR : path.join(UPLOAD_DIR, path.dirname(rel));
      fs.mkdirSync(finalDir, { recursive: true });
      const dest = path.join(finalDir, path.basename(rel));

      if (fs.existsSync(dest)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          /* ignore */
        }
        return res.json({
          skipped: true,
          reason: "duplicate",
          saved_as: path.relative(UPLOAD_DIR, dest),
          size: req.file.size,
        });
      }

      fs.renameSync(req.file.path, dest);
      res.json({
        skipped: false,
        saved_as: path.relative(UPLOAD_DIR, dest),
        size: req.file.size,
      });
    } catch (moveErr) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      res.status(500).json({ error: String(moveErr.message || moveErr) });
    }
  });
});

app.get("/api/uploads", (_req, res) => {
  const entries = [];
  function walk(dir, prefix = "") {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".gitkeep" || name === ".DS_Store") continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else entries.push({ name: rel, size: st.size, mtime: st.mtimeMs });
    }
  }
  walk(UPLOAD_DIR);
  entries.sort((a, b) => b.mtime - a.mtime);
  res.json({ files: entries });
});

const SHORTCUTS = {
  oupload: UPLOAD_DIR,
  Desktop: path.join(os.homedir(), "Desktop"),
  Downloads: path.join(os.homedir(), "Downloads"),
  Home: os.homedir(),
};

app.get("/api/browse", (req, res) => {
  const requested = req.query.path ? String(req.query.path) : UPLOAD_DIR;
  const current = path.resolve(requested);
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
    return res.status(400).json({ error: "not a folder" });
  }

  let fileCount = 0;
  function countFiles(dir) {
    for (const name of fs.readdirSync(dir)) {
      try {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) countFiles(full);
        else fileCount += 1;
      } catch {
        /* skip */
      }
    }
  }
  countFiles(current);

  const subdirs = fs
    .readdirSync(current)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(current, name))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .map((p) => ({ name: path.basename(p), path: p }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    path: current,
    parent: path.dirname(current),
    fileCount,
    subdirs,
    shortcuts: Object.fromEntries(Object.entries(SHORTCUTS)),
  });
});

app.post("/api/zip", express.json(), async (req, res) => {
  try {
    const folder = path.resolve(req.body.path || UPLOAD_DIR);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      return res.status(400).json({ error: "not a folder" });
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 15);
    const zipName = `${path.basename(folder)}_${stamp}.zip`;
    const zipPath = path.join(ZIP_DIR, zipName);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(folder, false);
      archive.finalize();
    });

    const st = fs.statSync(zipPath);
    res.json({
      name: zipName,
      path: zipPath,
      size: st.size,
      url: `/api/zips/${encodeURIComponent(zipName)}`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/zips", (_req, res) => {
  const zips = fs
    .readdirSync(ZIP_DIR)
    .filter((n) => n.endsWith(".zip"))
    .map((name) => {
      const full = path.join(ZIP_DIR, name);
      const st = fs.statSync(full);
      return {
        name,
        size: st.size,
        mtime: st.mtimeMs,
        url: `/api/zips/${encodeURIComponent(name)}`,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json({ zips });
});

app.get("/api/zips/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const full = path.join(ZIP_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.download(full, name);
});

const clientDist = path.join(ROOT, "client", "dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`API + app on http://0.0.0.0:${PORT}`);
  console.log(`Phone: http://${localIp()}:${PORT}`);
});
server.timeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;
