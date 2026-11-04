/**
 * Which desktop this webview is running on, for the few strings that name a
 * key. The keys themselves are handled in Rust (the global hotkeys) or by the
 * browser (`ctrlKey || metaKey` in handlers); this only decides what a label
 * says. WKWebView reports "MacIntel" on Intel and Apple silicon alike.
 */
export const isMac: boolean =
  /mac/i.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);

/**
 * Linux, where the app draws no splash and no in-app popup, so the settings
 * for them are hidden. Android also reports "Linux" but never runs this.
 */
export const isLinux: boolean = !isMac && /linux/i.test(navigator.platform);

/** The primary modifier, as a key label: Cmd on macOS, Ctrl elsewhere. */
export const MOD: string = isMac ? "Cmd" : "Ctrl";

/** The secondary modifier, as a key label: Option on macOS, Alt elsewhere. */
export const ALT: string = isMac ? "Option" : "Alt";
