// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpeechModelsStatus } from "../../domain/models";
import { useWorkspace } from "../../store/workspace";
import { WorkspaceStartup } from "./WorkspaceStartup";

vi.mock("../../services/desktop", () => ({ desktop: {} }));
vi.mock("../../lib/theme", () => ({ watchTheme: () => () => {} }));

const missing: SpeechModelsStatus = {
  state: "missing", downloadedBytes: 0, totalBytes: 300, error: null,
  models: ["Transcription", "Speaker separation", "Fingerprinting"].map((role) => ({
    id: role, role, name: role, licence: "", sizeBytes: 100, downloadedBytes: 0, installed: false, state: "missing",
  })),
};
const ready: SpeechModelsStatus = {
  ...missing, state: "ready", downloadedBytes: 300,
  models: missing.models.map((model) => ({ ...model, installed: true, downloadedBytes: 100, state: "ready" })),
};
const workspace = <WorkspaceStartup><button>Record</button></WorkspaceStartup>;

beforeEach(() => {
  useWorkspace.setState({ load: vi.fn(), loading: false, loadError: null, speechModels: missing, downloadSpeechModels: vi.fn() });
});
afterEach(cleanup);

it("keeps the workspace closed until all model downloads complete", () => {
  render(workspace);
  expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download models" }));
  expect(useWorkspace.getState().downloadSpeechModels).toHaveBeenCalledOnce();
  act(() => useWorkspace.setState({ speechModels: {
    ...missing, state: "downloading", downloadedBytes: 90,
    models: missing.models.map((model, index) => ({ ...model, downloadedBytes: 20 + index * 10, state: "downloading" })),
  } }));
  expect(screen.getAllByRole("progressbar").map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["20", "30", "40"]);
  expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
  act(() => useWorkspace.setState({ speechModels: ready }));
  fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
  expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
});

it("offers a retry on failed downloads and a resume for partial installs", () => {
  useWorkspace.setState({ speechModels: { ...missing, state: "failed", error: "Connection lost" } });
  render(workspace);
  expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  expect(screen.getByRole("button", { name: "Retry download" })).toBeInTheDocument();
  act(() => useWorkspace.setState({ speechModels: { ...missing, downloadedBytes: 40 } }));
  expect(screen.getByRole("button", { name: "Resume download" })).toBeInTheDocument();
});

it("opens an existing installation directly", () => {
  useWorkspace.setState({ speechModels: ready });
  render(workspace);
  expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open workspace" })).toBeNull();
});

it("offers a retry if startup could not read the installed models", () => {
  useWorkspace.setState({ speechModels: null, loadError: "Cannot read the models directory" });
  render(workspace);
  expect(screen.getByRole("alert")).toHaveTextContent("Cannot read the models directory");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(useWorkspace.getState().load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
});
