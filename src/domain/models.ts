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
  voiceProfile: VoiceProfileSummary | null;
  color: string;
  createdAt: string;
}

export type VoiceProfileStatus = "consent_required" | "pending_sample" | "learning" | "ready" | "failed";

export interface VoiceProfileSummary {
  status: VoiceProfileStatus;
  consentConfirmedAt: string | null;
  enrollmentDurationMs: number | null;
  enrollmentClipCount: number | null;
  source: string | null;
  updatedAt: string;
  lastError: string | null;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  speakerLabel: string;
  personId: string | null;
  identitySource: "manual" | "voiceprint" | "local_microphone" | null;
  identityConfidence: number | null;
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

export type ChatScopeType = "meeting" | "project";

export interface ChatScope {
  scopeType: ChatScopeType;
  scopeId: string;
}

export interface ChatMessage {
  id: string;
  scopeType: ChatScopeType;
  scopeId: string;
  role: "user" | "assistant";
  content: string;
  position: number;
  createdAt: string;
}

export interface AppSettings {
  microphoneDeviceId: string | null;
  systemDeviceId: string | null;
  captureMicrophone: boolean;
  captureSystem: boolean;
  theme: "light" | "dark" | "system";
  apiKeyConfigured: boolean;
  pyannoteApiKeyConfigured: boolean;
  privacyNoticeVersion: string | null;
  biometricConsentAcceptedAt: string | null;
  speakerIdentificationEnabled: boolean;
  localSpeakerPersonId: string | null;
  preferLocalSpeakerForMicrophone: boolean;
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
}
