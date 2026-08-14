export function focusFirstMenuItem(menu: HTMLElement | null): void {
  menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
}

export function moveMenuFocus(menu: HTMLElement, key: string): boolean {
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  if (!items.length) return false;

  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  let nextIndex: number;

  if (key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
  else if (key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
  else if (key === "Home") nextIndex = 0;
  else if (key === "End") nextIndex = items.length - 1;
  else return false;

  items[nextIndex]?.focus();
  return true;
}
