export type MeetingStatus = "draft" | "recording" | "processing" | "ready" | "failed";
export type CaptureKind = "microphone" | "system";

export interface Project {
  id: string;
  name: string;
  position: number;
  createdAt: string;
}

export interface Meeting {
  id: string;
  projectId: string | null;
  position: number;
  title: string;
  status: MeetingStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  audioDirectory: string | null;
  errorMessage: string | null;
}

export interface Person {
  id: string;
  fullName: string;
  nickname: string | null;
  photoDataUrl: string | null;
  referenceAudioDataUrl: string | null;
  color: string;
  createdAt: string;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  speakerLabel: string;
  personId: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export interface AudioDevice {
  id: string;
  name: string;
  subtitle?: string | null;
  kind: CaptureKind;
  isDefault: boolean;
  isAvailable: boolean;
}

export interface MeetingPlacement {
  id: string;
  projectId: string | null;
  position: number;
}

export interface RecordingLevels {
  microphone: number;
  system: number;
  elapsedMs: number;
}

export interface AppSettings {
  microphoneDeviceId: string | null;
  systemDeviceId: string | null;
  captureMicrophone: boolean;
  captureSystem: boolean;
  theme: "light" | "dark" | "system";
  apiKeyConfigured: boolean;
  pyannoteApiKeyConfigured: boolean;
}

export interface WorkspaceSnapshot {
  projects: Project[];
  meetings: Meeting[];
  people: Person[];
  segments: TranscriptSegment[];
  devices: AudioDevice[];
  settings: AppSettings;
}

export interface ProjectDraft {
  name: string;
}

export interface MeetingDraft {
  title: string;
  projectId: string | null;
}

export interface PersonDraft {
  fullName: string;
  nickname: string | null;
  photoDataUrl: string | null;
  referenceAudioDataUrl: string | null;
}
