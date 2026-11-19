import { ArrowRight, Download, LoaderCircle, Pause, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SpeechModelsStatus } from "../../domain/models";
import { formatBytes, isDownloading } from "../../lib/speechModels";
import { watchTheme } from "../../lib/theme";
import { useWorkspace } from "../../store/workspace";
import { ModelList } from "./SpeechModelsPanel";
import "./setup.css";

const appIcon = new URL("../../../assets/app-icon.svg", import.meta.url).href;

export function WorkspaceStartup({ children }: { children: ReactNode }) {
  const loading = useWorkspace((state) => state.loading);
  const loadError = useWorkspace((state) => state.loadError);
  const load = useWorkspace((state) => state.load);
  const status = useWorkspace((state) => state.speechModels);
  const theme = useWorkspace((state) => state.settings.theme);
  const started = useRef(false);
  const [inSetup, setInSetup] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);
  useEffect(() => watchTheme(theme), [theme]);
  useEffect(() => {
    if (status && status.state !== "ready") setInSetup(true);
  }, [status?.state]);

  if (loading) return <main className="app-loading" aria-label="Opening Listen" aria-busy="true"><LoaderCircle size={22} className="chat-spinner" /></main>;
  if (loadError || !status) {
    return (
      <main className="model-setup"><section className="model-setup-content">
        <h1>Couldn’t open Listen</h1>
        <p role="alert">{loadError ?? "Couldn’t check the installed models."}</p>
        <button type="button" className="secondary-button" onClick={() => void load()}><RotateCcw size={15} /> Try again</button>
      </section></main>
    );
  }
  if (status.state === "ready" && !inSetup) return children;
  return <ModelSetup status={status} onContinue={() => setInSetup(false)} />;
}

function ModelSetup({ status, onContinue }: { status: SpeechModelsStatus; onContinue: () => void }) {
  const download = useWorkspace((state) => state.downloadSpeechModels);
  const pause = useWorkspace((state) => state.cancelSpeechModelsDownload);
  const [starting, setStarting] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [pausedHere, setPausedHere] = useState(false);
  const busy = isDownloading(status);
  const ready = status.state === "ready";
  const failed = status.state === "failed";
  const paused = !busy && !ready && !failed && (pausedHere || status.downloadedBytes > 0);
  const title = ready ? "Ready to record" : failed ? "Download interrupted" : busy ? "Downloading models" : paused ? "Resume setup" : "Set up Listen";
  const buttonLabel = failed ? "Retry download" : paused ? "Resume download" : "Download models";

  async function startDownload(): Promise<void> {
    setStarting(true);
    setPauseRequested(false);
    setPausedHere(false);
    try {
      await download();
    } finally {
      setStarting(false);
    }
  }

  async function pauseDownload(): Promise<void> {
    setPauseRequested(true);
    setPausedHere(true);
    try {
      await pause();
    } finally {
      setPauseRequested(false);
    }
  }

  return (
    <main className="model-setup" aria-labelledby="model-setup-title">
      <section className="model-setup-content">
        <img className="model-setup-icon" src={appIcon} width="46" height="46" alt="" />
        <h1 id="model-setup-title" aria-live="polite">{title}</h1>
        {!ready && <p>These models transcribe recordings and identify speakers on your computer.</p>}
        <ModelList models={status.models} setup showProgress={busy || failed || paused} />
        {status.error && <p className="model-setup-error" role="alert">{status.error}</p>}
        <footer className="model-setup-actions">
          {!ready && <span>{busy || paused || failed ? `${formatBytes(status.downloadedBytes)} of ${formatBytes(status.totalBytes)}` : `${formatBytes(status.totalBytes)} download`}</span>}
          {ready ? (
            <button type="button" className="primary-button" onClick={onContinue}>Open workspace <ArrowRight size={15} /></button>
          ) : busy ? (
            <button type="button" className="secondary-button" disabled={pauseRequested} onClick={() => void pauseDownload()}><Pause size={14} /> Pause</button>
          ) : (
            <button type="button" className="primary-button" disabled={starting} onClick={() => void startDownload()}>{failed ? <RotateCcw size={15} /> : <Download size={15} />}{buttonLabel}</button>
          )}
        </footer>
      </section>
    </main>
  );
}
