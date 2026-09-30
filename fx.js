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
     reflect  — polished floor: a soft, Fresnel-weighted planar reflection
                (Duomo marble strongest, dark-mode wood faint, comic themes off)
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
    reflect: !lowTier,
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

  /* ─── Floor reflection ─── */
  // One Reflector plane spans every room's footprint just above the floors;
  // walls occlude it naturally. It's alpha-blended over the floor by a Fresnel
  // weight — a polished floor trades diffuse for specular, so the dark room
  // shows in it as much as the bright art and neon: faint looking straight
  // down, strong at grazing angles. Rendered at reduced resolution and softened with a
  // small disk blur so it reads as polish, not a mirror.
  const REFLECT_STRENGTH = { duomo: 1.0, dark: 0.45 };   // others: matte, off
  const FloorReflectShader = {
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      strength: { value: 0 },
      blur: { value: 0.004 },
    },
    vertexShader: `
      uniform mat4 textureMatrix;
      varying vec4 vUvR;
      varying vec3 vWorld;
      void main() {
        vUvR = textureMatrix * vec4(position, 1.0);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      uniform float strength;
      uniform float blur;
      varying vec4 vUvR;
      varying vec3 vWorld;
      void main() {
        vec2 uv = vUvR.xy / vUvR.w;
        vec3 v = normalize(cameraPosition - vWorld);
        float cosT = clamp(v.y, 0.0, 1.0);
        float fres = 0.2 + 0.8 * pow(1.0 - cosT, 3.0);
        // Blur grows with distance to the reflected point (contact-hardening-ish)
        float r = blur * (0.6 + 0.4 * (1.0 - cosT));
        vec3 acc = texture2D(tDiffuse, uv).rgb * 0.2;
        acc += texture2D(tDiffuse, uv + vec2( r, 0.0)).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2(-r, 0.0)).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2(0.0,  r)).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2(0.0, -r)).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2( r,  r) * 0.7).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2(-r,  r) * 0.7).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2( r, -r) * 0.7).rgb * 0.1;
        acc += texture2D(tDiffuse, uv + vec2(-r, -r) * 0.7).rgb * 0.1;
        // Fade with distance so it sits under the gallery's fog
        float fog = exp(-length(cameraPosition - vWorld) * 0.045);
        gl_FragColor = vec4(acc, clamp(strength * fres * fog, 0.0, 1.0));
      }`,
  };
  let floorRefl = null;
  function reflectStrength() { return REFLECT_STRENGTH[theme] || 0; }
  function buildFloorReflector() {
    if (!THREE.Reflector || typeof ROOMS === 'undefined') return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const id of Object.keys(ROOMS)) {
      const r = ROOMS[id];
      x0 = Math.min(x0, r.cx - r.w / 2); x1 = Math.max(x1, r.cx + r.w / 2);
      z0 = Math.min(z0, r.cz - r.d / 2); z1 = Math.max(z1, r.cz + r.d / 2);
    }
    if (!isFinite(x0)) return null;
    const pr = renderer.getPixelRatio();
    const scale = 0.5;
    const refl = new THREE.Reflector(new THREE.PlaneGeometry(x1 - x0, z1 - z0), {
      textureWidth: Math.round(window.innerWidth * pr * scale),
      textureHeight: Math.round(window.innerHeight * pr * scale),
      clipBias: 0.0005,
      shader: FloorReflectShader,
    });
    refl.rotation.x = -Math.PI / 2;
    refl.position.set((x0 + x1) / 2, 0.004, (z0 + z1) / 2);   // above the floors so they clip out of their own reflection
    refl.renderOrder = 1;
    const m = refl.material;
    m.transparent = true;
    m.blending = THREE.NormalBlending;
    m.depthWrite = false;
    // Only the main camera drives the reflection. Seen from any other camera
    // (the wall mirror's virtual view) the texture would be misaligned, so
    // the plane contributes nothing there — and the mirror is hidden while we
    // render, so the two reflectors never recurse into each other.
    const baseBefore = refl.onBeforeRender;
    refl.onBeforeRender = function (r, s, c) {
      if (c !== camera) { m.uniforms.strength.value = 0; return; }
      m.uniforms.strength.value = reflectStrength();
      const mm = (typeof mirrorMesh !== 'undefined') ? mirrorMesh : null;
      const mv = mm ? mm.visible : false;
      if (mm) mm.visible = false;
      baseBefore.call(this, r, s, c);
      if (mm) mm.visible = mv;
    };
    refl.userData.fxReflector = true;
    return refl;
  }
  function resizeReflector() {
    if (!floorRefl) return;
    const pr = renderer.getPixelRatio();
    floorRefl.getRenderTarget().setSize(Math.round(window.innerWidth * pr * 0.5), Math.round(window.innerHeight * pr * 0.5));
  }
  function syncReflector() {
    const want = settings.reflect && reflectStrength() > 0 && !(typeof mirrorWorld !== 'undefined' && mirrorWorld);
    if (want && !floorRefl) {
      floorRefl = buildFloorReflector();
      if (floorRefl) scene.add(floorRefl);
    }
    if (floorRefl) floorRefl.visible = want;
  }

  function init() {
    if (ready) return;
    ready = true;
    window.addEventListener('resize', () => {
      if (composer) composer.setSize(window.innerWidth, window.innerHeight);
      resizeReflector();
    });
  }

  function render() {
    init();
    syncSurfaces();
    syncReflector();
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

  return { settings, render, set, lowTier, _debug: () => ({ floorRefl, composer }) };
})();
window.FX = FX;
