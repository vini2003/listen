export interface ShortcutOptions {
  shift?: boolean;
}

export function usesMetaModifier(platform = currentPlatform()): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function shortcutLabel(key: string, options: ShortcutOptions = {}, platform = currentPlatform()): string {
  const displayKey = key.length === 1 ? key.toUpperCase() : key;
  if (usesMetaModifier(platform)) return `${options.shift ? "⇧" : ""}⌘${displayKey}`;
  return `Ctrl+${options.shift ? "Shift+" : ""}${displayKey}`;
}

export function shortcutAria(key: string, options: ShortcutOptions = {}, platform = currentPlatform()): string {
  return `${usesMetaModifier(platform) ? "Meta" : "Control"}+${options.shift ? "Shift+" : ""}${key.length === 1 ? key.toUpperCase() : key}`;
}

function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.platform || navigator.userAgent;
}
