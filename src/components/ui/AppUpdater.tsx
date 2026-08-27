import { isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { AnimatePresence, motion } from "framer-motion";
import { Download, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

interface AppUpdaterProps {
  recording: boolean;
}

let updateCheck: Promise<Update | null> | null = null;

export function AppUpdater({ recording }: AppUpdaterProps) {
  const [available, setAvailable] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const timer = window.setTimeout(() => {
      updateCheck ??= import("@tauri-apps/plugin-updater").then(({ check }) => check({ timeout: 15_000 }));
      void updateCheck
        .then((update) => { if (active) setAvailable(update); })
        .catch(() => { /* Update checks should never interrupt normal app startup. */ });
    }, 1_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  async function install(): Promise<void> {
    if (!available || recording || installing) return;
    setInstalling(true);
    setError(null);
    let downloaded = 0;
    let total: number | undefined;
    try {
      await available.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          setProgress(total ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total) setProgress(Math.min(100, Math.round(downloaded / total * 100)));
        } else {
          setProgress(100);
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      setInstalling(false);
      setProgress(null);
      setError("The update could not be installed. You can try again without losing your work.");
    }
  }

  function dismiss(): void {
    if (installing) return;
    const update = available;
    setAvailable(null);
    if (update) void update.close();
  }

  return (
    <AnimatePresence initial={false}>
      {available ? (
        <motion.section
          className="update-toast"
          role="status"
          aria-label={`Listen ${available.version} update available`}
          initial={{ opacity: 0, x: 24, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 18, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <span className="update-toast-icon">
            {installing ? <LoaderCircle className="update-spinner" size={17} /> : <Download size={17} />}
          </span>
          <div className="update-toast-copy">
            <strong>{installing ? "Installing update" : `Listen ${available.version} is available`}</strong>
            <span>{error ?? (recording ? "Finish the active recording before updating." : installing ? progress === null ? "Downloading securely…" : `Downloading securely… ${progress}%` : "Update now and restart when it is ready.")}</span>
            {installing && progress !== null ? <progress max={100} value={progress} aria-label="Update download progress" /> : null}
          </div>
          <div className="update-toast-actions">
            {!installing ? <button type="button" onClick={dismiss}>Later</button> : null}
            <button className="primary" type="button" disabled={recording || installing} onClick={() => void install()}>
              {installing ? <LoaderCircle className="update-spinner" size={14} /> : <Download size={14} />}
              {installing ? "Updating" : "Update"}
            </button>
          </div>
          {!installing ? <button className="update-toast-close" type="button" onClick={dismiss} aria-label="Dismiss update"><X size={14} /></button> : null}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
