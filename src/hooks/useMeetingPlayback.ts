import { useEffect, useRef, useState } from "react";
import type { Meeting } from "../domain/models";
import { useWorkspace } from "../store/workspace";

export interface MeetingPlayback {
  available: boolean;
  status: "idle" | "preparing" | "ready";
  playing: boolean;
  currentMs: number;
  durationMs: number;
  toggle: () => void;
  seek: (ms: number) => void;
  pause: () => void;
}

export function useMeetingPlayback(meeting: Meeting): MeetingPlayback {
  const loadMeetingAudioUrl = useWorkspace((state) => state.loadMeetingAudioUrl);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preparingRef = useRef(false);
  const pendingSeekMsRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const [status, setStatus] = useState<"idle" | "preparing" | "ready">("idle");
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(meeting.durationMs);

  const available = meeting.durationMs > 0
    && Boolean(meeting.audioDirectory)
    && meeting.status !== "recording";

  useEffect(() => {
    generationRef.current += 1;
    setStatus("idle");
    setPlaying(false);
    setCurrentMs(0);
    setDurationMs(meeting.durationMs);
    preparingRef.current = false;
    pendingSeekMsRef.current = null;
    return () => {
      generationRef.current += 1;
      const audio = audioRef.current;
      audioRef.current = null;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
    };
  }, [meeting.id, meeting.durationMs]);

  useEffect(() => {
    if (available) return;
    generationRef.current += 1;
    preparingRef.current = false;
    pendingSeekMsRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    setStatus("idle");
    setPlaying(false);
    setCurrentMs(0);
  }, [available]);

  async function prepare(): Promise<HTMLAudioElement | null> {
    const generation = generationRef.current;
    preparingRef.current = true;
    setStatus("preparing");
    try {
      const url = await loadMeetingAudioUrl(meeting.id);
      if (generationRef.current !== generation) return null;
      const audio = new Audio(url);
      audio.preload = "auto";
      audio.onloadedmetadata = () => {
        if (audioRef.current === audio && Number.isFinite(audio.duration)) {
          setDurationMs(Math.round(audio.duration * 1000));
        }
      };
      audio.ontimeupdate = () => {
        if (audioRef.current === audio) setCurrentMs(Math.round(audio.currentTime * 1000));
      };
      audio.onplay = () => { if (audioRef.current === audio) setPlaying(true); };
      audio.onpause = () => { if (audioRef.current === audio) setPlaying(false); };
      audio.onended = () => { if (audioRef.current === audio) setPlaying(false); };
      audioRef.current = audio;
      setStatus("ready");
      return audio;
    } catch {
      if (generationRef.current === generation) setStatus("idle");
      return null;
    } finally {
      if (generationRef.current === generation) preparingRef.current = false;
    }
  }

  async function start(seekMs?: number): Promise<void> {
    if (seekMs !== undefined) pendingSeekMsRef.current = seekMs;
    if (preparingRef.current) return;
    const audio = audioRef.current ?? await prepare();
    if (!audio || audioRef.current !== audio) return;
    const pending = pendingSeekMsRef.current;
    pendingSeekMsRef.current = null;
    if (pending !== null) {
      audio.currentTime = pending / 1000;
      setCurrentMs(pending);
    }
    try {
      await audio.play();
    } catch {
      // Playback can be interrupted by a meeting switch; state stays paused.
    }
  }

  function toggle(): void {
    if (preparingRef.current) return;
    const audio = audioRef.current;
    if (audio && !audio.paused) {
      audio.pause();
      return;
    }
    void start();
  }

  function seek(ms: number): void {
    void start(ms);
  }

  function pause(): void {
    audioRef.current?.pause();
  }

  return { available, status, playing, currentMs, durationMs, toggle, seek, pause };
}
