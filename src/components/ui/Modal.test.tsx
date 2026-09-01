// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

afterEach(() => {
  cleanup();
  MotionGlobalConfig.skipAnimations = false;
});

function renderModal(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <Modal open title="Test dialog" onClose={onClose} {...props}>
      <button>Inside</button>
    </Modal>,
  );
  return { onClose, view };
}

describe("Modal", () => {
  it("renders a dialog and closes on Escape and backdrop mouse down", () => {
    MotionGlobalConfig.skipAnimations = true;
    const { onClose } = renderModal();
    expect(screen.getByRole("dialog", { name: "Test dialog" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector(".modal-backdrop")!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores Escape and backdrop clicks when not dismissible", () => {
    MotionGlobalConfig.skipAnimations = true;
    const { onClose } = renderModal({ dismissible: false });

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unmounts after the exit animation", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal open title="Test dialog" onClose={onClose}><span>Body</span></Modal>,
    );
    rerender(<Modal open={false} title="Test dialog" onClose={onClose}><span>Body</span></Modal>);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("disables backdrop pointer events during the exit animation", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal open title="Test dialog" onClose={onClose}><span>Body</span></Modal>,
    );
    rerender(<Modal open={false} title="Test dialog" onClose={onClose}><span>Body</span></Modal>);

    // While the exiting backdrop is still mounted, its inline style must
    // block pointer hit-testing. (fireEvent bypasses hit-testing, so the
    // style itself is the observable contract here.)
    await waitFor(() => {
      const current = document.querySelector<HTMLElement>(".modal-backdrop");
      if (current) expect(current.style.pointerEvents).toBe("none");
      else expect(current).toBeNull();
    }, { timeout: 300, interval: 10 });
    await waitFor(() => expect(document.querySelector(".modal-backdrop")).toBeNull());
  });

  it("closes only the topmost dialog on Escape when stacked", () => {
    MotionGlobalConfig.skipAnimations = true;
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Modal open title="Outer" onClose={closeOuter}><span>Outer body</span></Modal>
        <Modal open title="Inner" onClose={closeInner}><span>Inner body</span></Modal>
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("prefers the initialFocus target over the first focusable", async () => {
    MotionGlobalConfig.skipAnimations = true;
    function Wrapper() {
      const targetRef = { current: null as HTMLElement | null };
      return (
        <Modal open title="Test dialog" onClose={() => {}} initialFocus={targetRef}>
          <button>First</button>
          <button ref={(node) => { targetRef.current = node; }}>Target</button>
        </Modal>
      );
    }
    render(<Wrapper />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Target" })).toHaveFocus());
  });
});
