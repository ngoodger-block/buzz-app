/** Desktop Mac WebKit: Safari and Tauri's WKWebView. Desktop-mode iPad also
 * reports MacIntel, but keeps its touch policies. */
export const macWebKit = () =>
  navigator.platform === "MacIntel" &&
  !navigator.maxTouchPoints &&
  navigator.vendor === "Apple Computer, Inc.";
