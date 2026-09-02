// WebXR session management. Hand tracking is requested as an optional feature so the
// experience still starts (with a message) on a headset with hand tracking off.
export function createXR(ctx) {
  const { renderer } = ctx;
  let session = null;
  ctx.xrBlurred = false;
  ctx.xrInputs = { hands: 0, controllers: 0 };

  async function isSupported() {
    if (!('xr' in navigator)) return false;
    try { return await navigator.xr.isSessionSupported('immersive-vr'); } catch { return false; }
  }

  function scanInputs(s) {
    let hands = 0, controllers = 0;
    try { for (const src of s.inputSources || []) { if (src.hand) hands++; else if (src.targetRayMode === 'tracked-pointer') controllers++; } } catch { /* */ }
    ctx.xrInputs.hands = hands; ctx.xrInputs.controllers = controllers;
  }

  // 'sessionend' from the renderer fires after three's own cleanup (size, camera), unlike the raw session 'end'
  renderer.xr.addEventListener('sessionend', () => {
    session = null;
    ctx.xrBlurred = false;
    ctx.xrInputs.hands = 0; ctx.xrInputs.controllers = 0;
    ctx.events.emit('xrend');
  });

  async function start() {
    if (session) return session;
    if (!('xr' in navigator)) throw new Error('WebXR is not available in this browser.');
    const init = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'high-refresh-rate'] };
    const s = await navigator.xr.requestSession('immersive-vr', init);
    session = s;
    try {
      s.addEventListener('inputsourceschange', (e) => { scanInputs(s); ctx.events.emit('inputsourceschange', e); });
      // The Quest system menu (palm pinch) blurs the session: freeze gestures, fade audio, and on
      // return make sure nothing is left "held" by a hand that is no longer there.
      s.addEventListener('visibilitychange', () => {
        const blurred = s.visibilityState !== 'visible';
        ctx.xrBlurred = blurred;
        ctx.events.emit(blurred ? 'xrblur' : 'xrfocus');
      });
      await renderer.xr.setSession(s);
    } catch (err) {
      try { await s.end(); } catch { /* */ }
      session = null;
      throw err;
    }
    ctx.xrBlurred = s.visibilityState !== 'visible';
    scanInputs(s);
    try { renderer.xr.setFoveation(0.5); } catch { /* ignore */ }
    const hasHands = !s.enabledFeatures || s.enabledFeatures.includes('hand-tracking');
    // announce immediately so the opening fade covers the very first frames
    ctx.events.emit('xrstart', { session: s, hasHands });
    // Prefer 72 Hz on Quest: the scene is fill-rate heavy and 72 is the most stable target. Not awaited.
    try {
      const rates = s.supportedFrameRates;
      if (rates && rates.length && s.updateTargetFrameRate) {
        const want = Array.from(rates).includes(72) ? 72 : rates[0];
        s.updateTargetFrameRate(want).catch(() => {});
      }
    } catch { /* not supported */ }
    return s;
  }

  async function end() {
    if (session) { try { await session.end(); } catch { /* already ended */ } }
  }

  return { isSupported, start, end, get session() { return session; } };
}
