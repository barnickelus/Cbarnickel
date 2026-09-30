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
     surface  — paintings read as physical objects: brush-stroke relief lifted
                from each image's own fine detail, linen weave, varnish sheen
*/
'use strict';

const FX = (() => {
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isSmall = Math.min(window.innerWidth, window.innerHeight) < 700;
  const lowTier = isTouch || isSmall;

  // Defaults: full stack on desktop; GPU-heavy features off on touch/small screens.
  const DEFAULTS = {
    post: !lowTier,
    surface: true,
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

  /* ─── Painting surface: relief + weave + varnish ─── */
  // Zero extra textures: the painting's own map doubles as its bump source.
  // Height = the image's fine detail (full-res luminance minus a blurred mip),
  // so brush strokes and palette-knife edges catch the spotlight while broad
  // shapes stay flat — a high-pass avoids the "embossed photo" look. A plain
  // weave adds linen tooth, faded out once threads drop below ~2px so it
  // never shimmers. Varnish = lower roughness, near-zero env reflection (the
  // warm env cube would otherwise haze the dark pieces).
  const SURFACE_GLSL = `
#ifdef USE_BUMPMAP
  uniform sampler2D bumpMap;
  uniform float bumpScale;
  uniform vec2 fxWeaveScale;
  uniform float fxWeave;
  uniform float fxRake;
  float fxLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  float fxWeaveH(vec2 uv) {
    vec2 w = uv * fxWeaveScale;
    vec2 f = fract(w), cell = floor(w);
    float over = mod(cell.x + cell.y, 2.0);
    float h = mix(sin(f.x * 3.14159), sin(f.y * 3.14159), over);
    vec2 fw = fwidth(w);
    return h * clamp(1.0 - max(fw.x, fw.y) * 2.2, 0.0, 1.0);
  }
  float fxH(vec2 uv) {
    float hi = fxLum(texture2D(bumpMap, uv).rgb);
    float lo = fxLum(texture2D(bumpMap, uv, 3.5).rgb);
    return (hi - lo) + fxWeave * fxWeaveH(uv);
  }
  vec2 dHdxy_fwd() {
    vec2 dSTdx = dFdx(vUv);
    vec2 dSTdy = dFdy(vUv);
    float Hll = bumpScale * fxH(vUv);
    float dBx = bumpScale * fxH(vUv + dSTdx) - Hll;
    float dBy = bumpScale * fxH(vUv + dSTdy) - Hll;
    return vec2(dBx, dBy);
  }
  vec3 perturbNormalArb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
    vec3 vSigmaX = vec3(dFdx(surf_pos.x), dFdx(surf_pos.y), dFdx(surf_pos.z));
    vec3 vSigmaY = vec3(dFdy(surf_pos.x), dFdy(surf_pos.y), dFdy(surf_pos.z));
    vec3 vN = surf_norm;
    vec3 R1 = cross(vSigmaY, vN);
    vec3 R2 = cross(vN, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDirection;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
  }
#endif
`;
  const SURFACE = { relief: 0.005, rake: 1.9, weave: 0.18, threadsPerM: 900, roughness: 0.46, env: 0.12 };

  function applySurface(p) {
    const m = p.material;
    if (!m || !m.map) return;
    if (!p.userData.fxOrig) {
      p.userData.fxOrig = { roughness: m.roughness, envMapIntensity: m.envMapIntensity };
    }
    const g = p.geometry.parameters || { width: 0.5, height: 0.4 };
    m.bumpMap = m.map;
    m.bumpScale = SURFACE.relief;
    m.roughness = SURFACE.roughness;
    m.envMapIntensity = SURFACE.env;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.fxWeaveScale = { value: new THREE.Vector2(g.width * SURFACE.threadsPerM, g.height * SURFACE.threadsPerM) };
      shader.uniforms.fxWeave = { value: SURFACE.weave };
      shader.uniforms.fxRake = { value: SURFACE.rake };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <bumpmap_pars_fragment>', SURFACE_GLSL)
        // The core material lifts every painting with emissive = its own map,
        // which no normal can shade. Rake that lift by the relief as if the
        // gallery spot above were its source, so strokes model in every light.
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          #ifdef USE_BUMPMAP
            vec3 fxUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
            float fxTilt = dot(normal - normalize(vNormal), fxUp);
            totalEmissiveRadiance *= clamp(1.0 + fxRake * fxTilt, 0.55, 1.45);
          #endif`);
    };
    m.customProgramCacheKey = () => 'fx-surface';
    m.needsUpdate = true;
    p.userData.fxSurface = true;
  }
  function removeSurface(p) {
    const m = p.material, o = p.userData.fxOrig;
    if (!m || !o) return;
    m.bumpMap = null;
    m.roughness = o.roughness;
    m.envMapIntensity = o.envMapIntensity;
    m.onBeforeCompile = function () {};
    m.customProgramCacheKey = function () { return ''; };
    m.needsUpdate = true;
    p.userData.fxSurface = false;
  }
  function syncSurfaces() {
    // Paintings load asynchronously — pick up newcomers every frame (cheap flag check).
    for (const p of paintingMeshes) {
      if (settings.surface && !p.userData.fxSurface) applySurface(p);
      else if (!settings.surface && p.userData.fxSurface) removeSurface(p);
    }
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
    syncSurfaces();
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
