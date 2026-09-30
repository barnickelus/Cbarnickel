/* ═══════════════════════════════════════════════════════════════════
   GALLERY FX — optional visual layer on top of the core gallery
   ═══════════════════════════════════════════════════════════════════
   Everything in here is additive and individually switchable. With every
   feature off, the gallery renders exactly as before (the core script's
   animate() falls back to a plain renderer.render when FX is absent).

   Shares the core script's global bindings (scene, camera, renderer, theme,
   paintingMeshes, ...) — classic scripts share one global lexical scope.

   Features (keys of FX.settings, persisted to localStorage 'fx'):
     post     — post-processing pipeline (MSAA render target + final passes)
*/
'use strict';

const FX = (() => {
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isSmall = Math.min(window.innerWidth, window.innerHeight) < 700;
  const lowTier = isTouch || isSmall;

  // Defaults: full stack on desktop; GPU-heavy features off on touch/small screens.
  const DEFAULTS = {
    post: !lowTier,
  };
  // Query override for side-by-side comparisons: ?fx=off / ?fx=on
  const q = new URLSearchParams(location.search).get('fx');

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('fx') || '{}') || {}; } catch (e) {}
  const siteDefaults = (typeof DEFAULT_SETTINGS !== 'undefined' && DEFAULT_SETTINGS.fx) || {};
  const settings = Object.assign({}, DEFAULTS, lowTier ? {} : siteDefaults, saved);
  if (q === 'off') Object.keys(settings).forEach(k => settings[k] = false);
  if (q === 'on') Object.keys(settings).forEach(k => settings[k] = true);

  function persist() {
    try { localStorage.setItem('fx', JSON.stringify(settings)); } catch (e) {}
  }

  /* ─── Post-processing pipeline ─── */
  let composer = null;
  let ready = false;

  function hasPostLibs() {
    return !!(THREE.EffectComposer && THREE.RenderPass && THREE.ShaderPass && THREE.CopyShader);
  }

  function makeTarget(w, h) {
    const pr = renderer.getPixelRatio();
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat };
    // MSAA inside the composer — the canvas's own antialias flag doesn't
    // apply to offscreen targets. WebGL2 only; WebGL1 falls back to plain.
    if (renderer.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget) {
      const rt = new THREE.WebGLMultisampleRenderTarget(w * pr, h * pr, opts);
      rt.samples = 4;
      return rt;
    }
    return new THREE.WebGLRenderTarget(w * pr, h * pr, opts);
  }

  function buildComposer() {
    if (!hasPostLibs()) return null;
    const w = window.innerWidth, h = window.innerHeight;
    const c = new THREE.EffectComposer(renderer, makeTarget(w, h));
    c.setPixelRatio(renderer.getPixelRatio());
    c.setSize(w, h);
    c.addPass(new THREE.RenderPass(scene, camera));
    const out = new THREE.ShaderPass(THREE.CopyShader);
    c.addPass(out);
    return c;
  }

  function init() {
    if (ready) return;
    ready = true;
    window.addEventListener('resize', () => {
      if (composer) composer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  function render() {
    init();
    if (settings.post) {
      if (!composer) composer = buildComposer();
      if (composer) { composer.render(); return; }
    }
    renderer.render(scene, camera);
  }

  function set(key, on) {
    if (!(key in settings)) return;
    settings[key] = !!on;
    persist();
  }

  return { settings, render, set, lowTier };
})();
window.FX = FX;
