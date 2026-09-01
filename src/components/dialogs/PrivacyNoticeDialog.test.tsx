// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../services/desktop", () => ({ desktop: {} }));

import { useWorkspace } from "../../store/workspace";
import { PrivacyNoticeDialog } from "./PrivacyNoticeDialog";

beforeAll(() => { MotionGlobalConfig.skipAnimations = true; });
afterAll(() => { MotionGlobalConfig.skipAnimations = false; });
afterEach(cleanup);

describe("PrivacyNoticeDialog", () => {
  it("reports the chosen consent outcome", () => {
    const acknowledge = vi.fn().mockResolvedValue(true);
    useWorkspace.setState({ busy: false, acknowledgePrivacyNotice: acknowledge });
    render(<PrivacyNoticeDialog open />);

    fireEvent.click(screen.getByRole("button", { name: "Continue without voice identification" }));
    expect(acknowledge).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: /enable voice identification/i }));
    expect(acknowledge).toHaveBeenLastCalledWith(true);
  });

  it("cannot be dismissed with Escape or a close button", () => {
    useWorkspace.setState({ busy: false, acknowledgePrivacyNotice: vi.fn() });
    render(<PrivacyNoticeDialog open />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close dialog" })).not.toBeInTheDocument();
  });
});
