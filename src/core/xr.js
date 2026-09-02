// WebXR session management. Hand tracking is requested as an optional feature so the
// experience still starts (with a message) on a headset with hand tracking off.
export function createXR(ctx) {
  const { renderer } = ctx;
  let session = null;

  async function isSupported() {
    if (!('xr' in navigator)) return false;
    try { return await navigator.xr.isSessionSupported('immersive-vr'); } catch { return false; }
  }

  async function start() {
    if (session) return session;
    if (!('xr' in navigator)) throw new Error('WebXR is not available in this browser.');
    const init = {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'high-refresh-rate'],
    };
    session = await navigator.xr.requestSession('immersive-vr', init);
    session.addEventListener('end', onEnd);
    session.addEventListener('inputsourceschange', (e) => ctx.events.emit('inputsourceschange', e));
    // The Quest system menu (palm pinch) blurs the session: freeze gestures, fade audio, and on
    // return make sure nothing is left "held" by a hand that is no longer there.
    session.addEventListener('visibilitychange', () => {
      const blurred = session.visibilityState !== 'visible';
      ctx.xrBlurred = blurred;
      ctx.events.emit(blurred ? 'xrblur' : 'xrfocus');
    });
    await renderer.xr.setSession(session);
    try { renderer.xr.setFoveation(1.0); } catch { /* ignore */ }
    // Prefer 72 Hz on Quest: the scene is fill-rate heavy and 72 is the most stable target.
    try {
      const rates = session.supportedFrameRates;
      if (rates && rates.length && session.updateTargetFrameRate) {
        const want = Array.from(rates).includes(72) ? 72 : rates[0];
        await session.updateTargetFrameRate(want);
      }
    } catch { /* not supported */ }
    const hasHands = !session.enabledFeatures || session.enabledFeatures.includes('hand-tracking');
    ctx.events.emit('xrstart', { session, hasHands });
    return session;
  }

  function onEnd() {
    session = null;
    ctx.events.emit('xrend');
  }

  async function end() {
    if (session) { try { await session.end(); } catch { /* already ended */ } }
  }

  return { isSupported, start, end, get session() { return session; } };
}
