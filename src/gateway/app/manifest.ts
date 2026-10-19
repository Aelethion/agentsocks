import { THEME_DARK } from "./page.ts";

export function manifest(): Record<string, unknown> {
  return {
    name: "agentsocks",
    short_name: "agentsocks",
    start_url: "/app/",
    scope: "/app/",
    display: "standalone",
    background_color: THEME_DARK,
    theme_color: THEME_DARK,
    icons: [{ src: "/app/icon.png", sizes: "180x180", type: "image/png", purpose: "any" }],
  };
}
