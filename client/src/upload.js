export function formatSize(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function mergeFiles(existing, incoming) {
  const map = new Map();
  for (const f of [...existing, ...incoming]) {
    const key = `${f.webkitRelativePath || f.name}::${f.size}::${f.lastModified}`;
    map.set(key, f);
  }
  return Array.from(map.values());
}

async function alreadyExists(relativePath) {
  const res = await fetch(
    `/api/exists?filename=${encodeURIComponent(relativePath)}`
  );
  const data = await res.json().catch(() => ({}));
  return Boolean(data.exists);
}

function uploadOneFile(file, relativePath, onFileProgress) {
  return new Promise((resolve, reject) => {
    const name = relativePath || file.name;
    const form = new FormData();
    form.append("filename", name);
    form.append("file", file, pathBasename(name));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      onFileProgress(e.loaded, e.total);
    };

    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onFileProgress(file.size, file.size);
        resolve(data);
      } else {
        reject(new Error(data.error || `Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}

function pathBasename(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "upload.bin";
}

/** Upload files one-by-one; skip names that already exist in oupload. */
export async function uploadAll(fileList, pathFn, onProgress) {
  const list = Array.from(fileList);
  if (!list.length) return { saved: 0, skipped: 0 };

  const totalBytes = list.reduce((s, f) => s + f.size, 0) || 1;
  let sentBytes = 0;
  let saved = 0;
  let skipped = 0;

  for (let fi = 0; fi < list.length; fi++) {
    const file = list[fi];
    const rel = pathFn(file);
    const name = rel || file.name;

    const exists = await alreadyExists(name);
    if (exists) {
      skipped += 1;
      sentBytes += file.size;
      const overall = Math.min(100, Math.round((sentBytes / totalBytes) * 100));
      onProgress({
        overall,
        fileIndex: fi + 1,
        totalFiles: list.length,
        name,
        filePct: 100,
        skipped: true,
        mbDone: (sentBytes / (1024 * 1024)).toFixed(1),
        mbTotal: (totalBytes / (1024 * 1024)).toFixed(1),
        saved,
        skippedCount: skipped,
      });
      continue;
    }

    const result = await uploadOneFile(file, rel, (loaded, total) => {
      const fileSent = Math.min(loaded, total || file.size);
      const overall = Math.min(
        100,
        Math.round(((sentBytes + fileSent) / totalBytes) * 100)
      );
      onProgress({
        overall,
        fileIndex: fi + 1,
        totalFiles: list.length,
        name,
        filePct: total ? Math.round((fileSent / total) * 100) : 0,
        skipped: false,
        mbDone: ((sentBytes + fileSent) / (1024 * 1024)).toFixed(1),
        mbTotal: (totalBytes / (1024 * 1024)).toFixed(1),
        saved,
        skippedCount: skipped,
      });
    });

    sentBytes += file.size;
    if (result?.skipped) skipped += 1;
    else saved += 1;
  }

  onProgress({
    overall: 100,
    fileIndex: list.length,
    totalFiles: list.length,
    name: "done",
    filePct: 100,
    mbDone: (totalBytes / (1024 * 1024)).toFixed(1),
    mbTotal: (totalBytes / (1024 * 1024)).toFixed(1),
    finished: true,
    saved,
    skippedCount: skipped,
  });

  return { saved, skipped };
}
