// Launch the system Chrome (no tool downloads its own Chromium): DEMO_CHROME=<binary>, else Google Chrome via
// Playwright's `chrome` channel (macOS app, or google-chrome-stable on Linux).
import { chromium } from "playwright";

export function launchChrome(opts = {}) {
  const exe = process.env.DEMO_CHROME;
  return chromium.launch(exe ? { executablePath: exe, ...opts } : { channel: "chrome", ...opts });
}
