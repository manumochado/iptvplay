/**
 * Entra en pantalla completa en el mismo gesto del usuario (llamar antes de cualquier await).
 */
export function tryEnterPlaybackFullscreen(element) {
  if (!element || typeof document === "undefined") return;
  const req =
    element.requestFullscreen ||
    element.webkitRequestFullscreen ||
    element.msRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(element);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* noop */
  }
}

export function isAnyFullscreen() {
  return Boolean(
    document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
  );
}
