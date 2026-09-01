export type ThemePreference = "light" | "dark" | "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLORS = { light: "#f4f4f1", dark: "#171716" } as const;

export function resolveTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

export function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference, window.matchMedia(DARK_QUERY).matches);
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
}

export function watchTheme(preference: ThemePreference): () => void {
  applyTheme(preference);
  if (preference !== "system") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const onChange = (): void => applyTheme(preference);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
