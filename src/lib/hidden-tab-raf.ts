/**
 * Dev-only frame-source shim for hidden tabs.
 *
 * Browsers never fire requestAnimationFrame while document.visibilityState is
 * 'hidden'. Some preview/embedded browser panes host their tab permanently in
 * that state. MapLibre drives its entire render loop from rAF, so under those
 * conditions the map silently never finishes loading its style: no 'load'
 * event, no layers, and a canvas stuck at MapLibre's 400x300 fallback size.
 * Nothing errors, which makes it look like a bug in the app.
 *
 * Substituting a timer-based frame source restores rendering for screenshots
 * and manual checks.
 *
 * Deliberately narrow: dev builds only, and only when the document is already
 * hidden at startup. A real browser tab keeps native rAF and its vsync
 * alignment, and this code is not present in a production build at all.
 */

const FRAME_MS = 16;

if (import.meta.env.DEV && typeof document !== 'undefined' && document.hidden) {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), FRAME_MS);
  window.cancelAnimationFrame = (handle: number): void => window.clearTimeout(handle);
}
