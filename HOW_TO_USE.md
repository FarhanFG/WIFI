# How to use WIFI Upload

Transfer photos and files from your phone to this Mac over the same Wi‑Fi network.

## Requirements

- Node.js 18+ (20+ recommended)
- Phone and Mac on the **same Wi‑Fi**

## Install (first time)

```bash
cd WIFI
npm install
cd client && npm install && cd ..
```

## Run

```bash
npm run dev
```

That starts:

- API on port **3000**
- React UI on port **5173**

On your Mac open: [http://localhost:5173](http://localhost:5173)

On your phone open the Network URL shown in the terminal, for example:

`http://192.168.x.x:5173`

(The app header also shows this address.)

## Upload files

1. Open the **Upload** tab
2. Select one or more files (visible file picker)
3. If “Select all” only returns one file on Android, tap **Add more files** and pick in batches
4. Tap **Upload all**
5. Files save into the local `oupload/` folder on the Mac

Notes:

- Files upload **one after another** (full file, not chunked)
- Max size **5 GB** per file
- If a file with the **same path/name** already exists in `oupload/`, it is **skipped**

## Upload a folder

1. Open the **Folder** tab
2. Choose a folder (works best in **Chrome on Android**)
3. Tap **Upload folder**
4. Folder structure is preserved under `oupload/`

iPhone Safari often cannot select whole folders — use **Upload** and multi-select instead.

## Zip a folder

1. Open the **Zip** tab
2. Tap shortcuts (oupload / Desktop / Downloads / Home) or browse subfolders
3. Tap **Create zip of this folder**
4. Download from the list (zips are stored in `zips/` on the Mac)

## If port 3000 is already in use

```bash
lsof -ti:3000,5173 | xargs kill -9
npm run dev
```

## Production (optional)

```bash
npm run build
npm start
```

Then open `http://<your-mac-ip>:3000` (API serves the built UI).

## What is not in git

These folders are ignored and stay only on your Mac:

- `oupload/` — received files
- `zips/` — created zip archives
- `.upload_tmp/` — temporary upload data
- `node_modules/`
