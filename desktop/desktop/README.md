# CheesePie Tracker Preview (Tauri)

This desktop app previews the video that corresponds to a tracking output file.

## What it does
- Accepts tracking files ending in `.mp4.obj.mat` or `.avi.obj.mat`.
- Searches the same folder for the matching video by removing the `.obj.mat` suffix.
- Loads the video into a preview player with standard playback controls.
- Supports Open dialog, drag-and-drop, or opening a file with the app.

## Development setup
```bash
cd desktop
npm install
npm run tauri dev
```

To launch with a tracking file in dev mode:
```bash
npm run tauri dev -- /absolute/path/to/video.mp4.obj.mat
```

## File associations
`src-tauri/tauri.conf.json` registers a file association for `.obj.mat`. Packaging
will let the OS send matching files to the app; the frontend still validates that
the file ends with `.mp4.obj.mat` or `.avi.obj.mat`.
