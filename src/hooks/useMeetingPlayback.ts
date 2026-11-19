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
  playFrom: (ms: number) => void;
  pause: () => void;
}

export function useMeetingPlayback(meeting: Meeting): MeetingPlayback {
  const loadMeetingAudioUrl = useWorkspace((state) => state.loadMeetingAudioUrl);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preparingRef = useRef(false);
  const playRequestedRef = useRef(false);
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
    playRequestedRef.current = false;
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
  }, [meeting.id, meeting.durationMs, available]);

  function applyPendingSeek(audio: HTMLAudioElement): void {
    const target = pendingSeekMsRef.current;
    if (target === null || audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const position = Number.isFinite(audio.duration) ? Math.min(target, audio.duration * 1000) : target;
    audio.currentTime = position / 1000;
    pendingSeekMsRef.current = null;
    setCurrentMs(position);
  }

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
        if (audioRef.current !== audio) return;
        if (Number.isFinite(audio.duration)) setDurationMs(Math.round(audio.duration * 1000));
        applyPendingSeek(audio);
      };
      audio.ontimeupdate = () => {
        if (audioRef.current === audio && pendingSeekMsRef.current === null) setCurrentMs(Math.round(audio.currentTime * 1000));
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

  async function play(): Promise<void> {
    if (!available) return;
    playRequestedRef.current = true;
    if (preparingRef.current) return;
    const audio = audioRef.current ?? await prepare();
    if (!audio || audioRef.current !== audio || !playRequestedRef.current) return;
    applyPendingSeek(audio);
    if (!audio.paused) return;
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
      pause();
      return;
    }
    void play();
  }

  function seek(ms: number): void {
    if (!available || !Number.isFinite(ms)) return;
    const position = Math.max(0, Math.min(ms, durationMs));
    pendingSeekMsRef.current = position;
    setCurrentMs(position);
    if (audioRef.current) applyPendingSeek(audioRef.current);
  }

  function playFrom(ms: number): void {
    seek(ms);
    void play();
  }

  function pause(): void {
    playRequestedRef.current = false;
    audioRef.current?.pause();
  }

  return { available, status, playing, currentMs, durationMs, toggle, seek, playFrom, pause };
}
