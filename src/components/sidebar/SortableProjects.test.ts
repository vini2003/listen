import { expect, it } from "vitest";
import { findProjectTarget } from "./SortableProjects";

function rect(top: number, height: number) {
  return { top, bottom: top + height, height, left: 0, right: 200, width: 200 };
}

const sections = new Map([
  ["first", rect(0, 40)],
  ["expanded", rect(40, 200)],
  ["last", rect(240, 40)],
]);

function target(id: string, offset: number) {
  const initial = sections.get(id)!;
  const moved = rect(initial.top + offset, initial.height);
  return findProjectTarget({
    active: { id, data: { current: undefined }, rect: { current: { initial, translated: moved } } },
    collisionRect: moved, droppableRects: sections, droppableContainers: [], pointerCoordinates: null,
  })[0]?.id;
}

it("waits for the moving edge to cross the entire expanded neighbor’s midpoint", () => {
  expect(target("first", 99)).toBe("first");
  expect(target("first", 101)).toBe("expanded");
  expect(target("last", -99)).toBe("last");
  expect(target("last", -101)).toBe("expanded");
});

it("uses either edge of the lifted section and can cross multiple projects in one move", () => {
  expect(target("expanded", 21)).toBe("last");
  expect(target("expanded", -21)).toBe("first");
  expect(target("first", 230)).toBe("last");
  expect(target("last", -230)).toBe("first");
});
