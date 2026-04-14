import { open } from "@tauri-apps/api/dialog";
import { exists } from "@tauri-apps/api/fs";
import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { appWindow } from "@tauri-apps/api/window";

const allowedSuffixes = [".mp4.obj.mat", ".avi.obj.mat"];
const dropZone = document.querySelector("#drop-zone");
const openButton = document.querySelector("#open-button");
const statusEl = document.querySelector("#status");
const filePathEl = document.querySelector("#file-path");
const videoEl = document.querySelector("#video-player");

const setStatus = (message, isError = false) => {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#f97316" : "#e2e8f0";
};

const isTrackingFile = (path) => {
  if (!path) {
    return false;
  }
  const normalized = path.toLowerCase();
  return allowedSuffixes.some((suffix) => normalized.endsWith(suffix));
};

const deriveVideoPath = (trackingPath) => {
  if (!trackingPath) {
    return "";
  }
  if (trackingPath.toLowerCase().endsWith(".obj.mat")) {
    return trackingPath.slice(0, -".obj.mat".length);
  }
  return trackingPath;
};

const loadTrackingFile = async (path) => {
  if (!path) {
    return;
  }

  if (!isTrackingFile(path)) {
    setStatus("Unsupported file. Expect .mp4.obj.mat or .avi.obj.mat.", true);
    return;
  }

  const videoPath = deriveVideoPath(path);
  const hasVideo = await exists(videoPath);
  if (!hasVideo) {
    setStatus(`Missing video file: ${videoPath}`, true);
    filePathEl.textContent = `Tracking: ${path}`;
    videoEl.removeAttribute("src");
    videoEl.load();
    return;
  }

  const src = convertFileSrc(videoPath);
  videoEl.src = src;
  videoEl.load();
  filePathEl.textContent = `Tracking: ${path} | Video: ${videoPath}`;
  setStatus("Loaded tracking video preview.");
};

const openTrackingFile = async () => {
  const selection = await open({
    multiple: false,
    filters: [
      {
        name: "Tracking Files",
        extensions: ["obj.mat", "mp4.obj.mat", "avi.obj.mat"],
      },
    ],
  });

  if (typeof selection === "string") {
    await loadTrackingFile(selection);
  } else if (Array.isArray(selection) && selection.length) {
    await loadTrackingFile(selection[0]);
  }
};

const handleFileDrop = async (paths) => {
  if (!paths || !paths.length) {
    return;
  }
  await loadTrackingFile(paths[0]);
};

openButton.addEventListener("click", () => {
  openTrackingFile().catch((error) =>
    setStatus(`Failed to open file: ${error}`, true)
  );
});

dropZone.addEventListener("dragenter", () => {
  dropZone.classList.add("is-dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragover");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragover");
});

document.addEventListener("dragover", (event) => {
  event.preventDefault();
});

document.addEventListener("drop", (event) => {
  event.preventDefault();
});

appWindow.onFileDropEvent((event) => {
  if (event.payload && event.type === "drop") {
    handleFileDrop(event.payload).catch((error) =>
      setStatus(`Failed to load dropped file: ${error}`, true)
    );
  }
});

const loadInitialFiles = async () => {
  try {
    const pending = await invoke("take_pending_files");
    if (Array.isArray(pending) && pending.length) {
      await loadTrackingFile(pending[0]);
    }
  } catch (error) {
    setStatus(`Failed to read startup file: ${error}`, true);
  }
};

loadInitialFiles();
