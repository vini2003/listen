// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CustomSelect } from "./CustomSelect";
import { Modal } from "./Modal";

beforeAll(() => { MotionGlobalConfig.skipAnimations = true; });
afterAll(() => { MotionGlobalConfig.skipAnimations = false; });
afterEach(cleanup);

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("CustomSelect", () => {
  it("opens a portaled listbox and chooses with the keyboard", () => {
    const onChange = vi.fn();
    render(<CustomSelect value="a" options={options} onChange={onChange} ariaLabel="Letter" />);

    const trigger = screen.getByRole("combobox", { name: "Letter" });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Letter" });
    expect(document.body.contains(listbox)).toBe(true);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on an outside pointer down", () => {
    render(<CustomSelect value="a" options={options} onChange={() => {}} ariaLabel="Letter" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes immediately when the enclosing modal starts closing", async () => {
    function Wrapper({ open }: { open: boolean }) {
      return (
        <Modal open={open} title="Settings" onClose={() => {}}>
          <CustomSelect value="a" options={options} onChange={() => {}} ariaLabel="Letter" />
        </Modal>
      );
    }
    const { rerender } = render(<Wrapper open />);
    fireEvent.click(screen.getByRole("combobox", { name: "Letter" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    rerender(<Wrapper open={false} />);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });
});
