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
     bloom    — the neon sign and neon plants throw real light: a selective
                bloom (only neon blooms; walls still occlude it)
     atmos    — air you can see: faint beams under every painting spotlight and
                slow dust motes drifting through them
     contact  — baked contact shadow: floors darken softly where they meet the
                walls and corners darken up their height (no screen-space AO)
     film     — lens vignette + fine animated film grain, as a CSS overlay
                (zero GPU cost, so it's on for phones too)
     spill    — the neon lights its surroundings: coloured light pooled on the
                floor and the nearby walls, flickering with the sign
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
    bloom: !lowTier,
    atmos: true,
    contact: true,
    film: true,
    spill: true,
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
    finalPass = new THREE.ShaderPass(FinalShader);
    c.addPass(finalPass);
    return c;
  }

  // Final composite: scene + selective bloom.
  const FinalShader = {
    uniforms: {
      tDiffuse: { value: null },
      tBloom: { value: null },
      bloomStrength: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform float bloomStrength;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        if (bloomStrength > 0.0) c.rgb += texture2D(tBloom, vUv).rgb * bloomStrength;
        gl_FragColor = c;
      }`,
  };
  let finalPass = null;

  /* ─── Selective neon bloom ─── */
  // Mask = the neon alone, depth-tested against a colour-less depth prepass
  // of everything else (so a wall still hides the sign). The mask is blurred
  // by an UnrealBloomPass; only its pure-glow target is added back, so the
  // tubes themselves keep their exact baked look and just gain a halo.
  const NEON_LAYER = 5;
  const BLOOM_STRENGTH = 1.1;
  let maskRT = null, bloomPass = null, depthMat = null;
  const _clear = new THREE.Color();
  const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _box = new THREE.Box3();
  function neonObjects() {
    const out = [];
    if (typeof lobbyTitleMesh !== 'undefined' && lobbyTitleMesh && neonTitle) out.push(lobbyTitleMesh);
    if (typeof neonPlantMeshes !== 'undefined') for (const g of neonPlantMeshes) out.push(...g.children);
    return out;
  }
  function neonInView(list) {
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    for (const o of list) {
      if (!o.visible || !o.parent) continue;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      if (_frustum.intersectsBox(_box)) return true;
    }
    return false;
  }
  function ensureBloom() {
    if (bloomPass || !THREE.UnrealBloomPass) return !!bloomPass;
    const pr = renderer.getPixelRatio();
    const w = Math.round(window.innerWidth * pr / 2), h = Math.round(window.innerHeight * pr / 2);
    maskRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 1.0, 0.55, 0.0);
    bloomPass.setSize(w, h);
    depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    return true;
  }
  function renderBloom() {
    const list = neonObjects();
    if (!list.length || !neonInView(list) || !ensureBloom()) return 0;
    for (const o of list) o.layers.enable(NEON_LAYER);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(_clear);
    const prevAlpha = renderer.getClearAlpha();
    const prevMask = camera.layers.mask;
    const prevFog = scene.fog;
    // Reflectors would re-render the whole scene from inside this pass — hide them.
    const mm = (typeof mirrorMesh !== 'undefined') ? mirrorMesh : null;
    const mmVis = mm ? mm.visible : false, frVis = floorRefl ? floorRefl.visible : false;
    if (mm) mm.visible = false;
    if (floorRefl) floorRefl.visible = false;

    renderer.setRenderTarget(maskRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;
    // 1) depth of everything except the neon
    const neonVis = list.map(o => o.visible);
    list.forEach(o => { o.visible = false; });
    scene.overrideMaterial = depthMat;
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    list.forEach((o, i) => { o.visible = neonVis[i]; });
    // 2) the neon alone, depth-tested (no fog: the glow shouldn't grey out)
    scene.fog = null;
    camera.layers.set(NEON_LAYER);
    renderer.render(scene, camera);
    camera.layers.mask = prevMask;
    scene.fog = prevFog;

    renderer.autoClear = prevAuto;
    renderer.setClearColor(_clear, prevAlpha);
    if (mm) mm.visible = mmVis;
    if (floorRefl) floorRefl.visible = frVis;
    // 3) blur
    bloomPass.render(renderer, null, maskRT, 0, false);
    renderer.setRenderTarget(prevTarget);
    return 1;
  }
  function resizeBloom() {
    if (!bloomPass) return;
    const pr = renderer.getPixelRatio();
    const w = Math.round(window.innerWidth * pr / 2), h = Math.round(window.innerHeight * pr / 2);
    maskRT.setSize(w, h);
    bloomPass.setSize(w, h);
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

  /* ─── Atmosphere: spotlight beams + dust ─── */
  // Each painting spot gets a soft cone: brightest along its core and near
  // the lamp, feathered at the rim (view-angle falloff) and fading as it
  // lands on the wall, so it reads as lit air rather than geometry. Motes
  // drift inside the cones and only sparkle where the beam would catch them.
  // Additive, no depth write, one draw call per beam + one for all dust.
  const ATMOS = { duomo: 1.0, dark: 0.9, spotlight: 1.1, white: 0.0, ink: 0.0 };
  const BeamShader = {
    uniforms: { color: { value: new THREE.Color() }, strength: { value: 0 }, time: { value: 0 } },
    vertexShader: `
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vLocal;
      void main() {
        vAlong = uv.y;                          // 1 at the lamp, 0 at the wall
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = cameraPosition - wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float strength;
      uniform float time;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vLocal;
      void main() {
        vec3 v = normalize(vView);
        float edge = abs(dot(normalize(vN), v));          // 1 = looking through the core
        float core = pow(edge, 2.2);
        float along = smoothstep(0.0, 0.35, vAlong) * (0.35 + 0.65 * vAlong);
        float nearFade = smoothstep(0.4, 2.2, length(vView));  // don't fog the lens
        float drift = 0.85 + 0.15 * sin(vLocal.y * 3.0 + time * 0.4 + vLocal.x * 5.0);
        float a = core * along * nearFade * drift * strength;
        gl_FragColor = vec4(color * a, 1.0);
      }`,
  };
  const DustShader = {
    uniforms: { time: { value: 0 }, strength: { value: 0 }, color: { value: new THREE.Color(0xffe6c0) }, pr: { value: 1 } },
    vertexShader: `
      attribute vec3 seed;       // random 0..1 triplet
      attribute vec3 apex;       // lamp position
      attribute vec3 axis;       // unit beam direction
      attribute vec2 dims;       // length, end radius
      uniform float time;
      uniform float pr;
      varying float vA;
      void main() {
        float t = fract(seed.x + time * 0.004 * (0.5 + seed.y));   // slow fall along the beam
        float along = mix(0.18, 0.98, t);
        vec3 up = abs(axis.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 u = normalize(cross(axis, up)), w = cross(axis, u);
        float ang = seed.z * 6.2832 + time * 0.05 * (seed.y - 0.5);
        float rad = sqrt(seed.y) * dims.y * along * 0.85;
        vec3 p = apex + axis * (along * dims.x) + (u * cos(ang) + w * sin(ang)) * rad;
        p += 0.03 * vec3(sin(time * 0.31 + seed.x * 40.0), sin(time * 0.23 + seed.z * 30.0), cos(time * 0.27 + seed.y * 50.0));
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        gl_PointSize = pr * clamp(26.0 / dist, 1.0, 5.0);
        float tw = 0.55 + 0.45 * sin(time * (0.8 + seed.x * 1.7) + seed.z * 20.0);
        float edgeFade = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.85, t);
        vA = tw * edgeFade * smoothstep(0.5, 1.6, dist) * (1.0 - smoothstep(6.0, 12.0, dist));
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float strength;
      varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d) * 4.0;
        float a = exp(-r * 3.0) * vA * strength;
        gl_FragColor = vec4(color * a, 1.0);
      }`,
  };
  const atmos = { group: null, beams: [], dust: null, spotCount: -1 };
  const _up = new THREE.Vector3(0, 1, 0);
  function buildAtmos() {
    const group = new THREE.Group();
    group.name = 'fx-atmos';
    const beams = [];
    const spots = lightingRefs.spots;
    const MOTES = 22;
    const seeds = [], apexes = [], axes = [], dimsArr = [], pos = [];
    for (const sp of spots) {
      const a = sp.position, b = sp.target.position;
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      dir.normalize();
      const endR = Math.tan(sp.angle * 0.62) * len;
      // Cone: apex at the lamp (+Y in geometry space), open end at the wall
      const geo = new THREE.CylinderGeometry(0.035, endR, len, 28, 1, true);
      geo.translate(0, -len / 2, 0);
      const mat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(BeamShader.uniforms),
        vertexShader: BeamShader.vertexShader,
        fragmentShader: BeamShader.fragmentShader,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      mat.uniforms.color.value.copy(sp.color);
      const cone = new THREE.Mesh(geo, mat);
      cone.position.copy(a);
      cone.quaternion.setFromUnitVectors(_up, dir.clone().negate());
      cone.renderOrder = 2;
      cone.userData.spot = sp;
      group.add(cone);
      beams.push(cone);
      for (let i = 0; i < MOTES; i++) {
        seeds.push(Math.random(), Math.random(), Math.random());
        apexes.push(a.x, a.y, a.z);
        axes.push(dir.x, dir.y, dir.z);
        dimsArr.push(len, endR);
        pos.push(a.x, a.y, a.z);
      }
    }
    if (spots.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 3));
      g.setAttribute('apex', new THREE.Float32BufferAttribute(apexes, 3));
      g.setAttribute('axis', new THREE.Float32BufferAttribute(axes, 3));
      g.setAttribute('dims', new THREE.Float32BufferAttribute(dimsArr, 2));
      const m = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(DustShader.uniforms),
        vertexShader: DustShader.vertexShader,
        fragmentShader: DustShader.fragmentShader,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      m.uniforms.pr.value = renderer.getPixelRatio();
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false;
      pts.renderOrder = 3;
      group.add(pts);
      atmos.dust = pts;
    }
    atmos.group = group;
    atmos.beams = beams;
    atmos.spotCount = spots.length;
    scene.add(group);
  }
  function disposeAtmos() {
    if (!atmos.group) return;
    scene.remove(atmos.group);
    atmos.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    atmos.group = null; atmos.beams = []; atmos.dust = null;
  }
  function syncAtmos(now) {
    const k = ATMOS[theme] || 0;
    const want = settings.atmos && k > 0 && !(typeof mirrorWorld !== 'undefined' && mirrorWorld);
    if (!want) { if (atmos.group) atmos.group.visible = false; return; }
    if (atmos.group && atmos.spotCount !== lightingRefs.spots.length) disposeAtmos();
    if (!atmos.group) { if (!lightingRefs.spots.length) return; buildAtmos(); }
    atmos.group.visible = true;
    const t = now / 1000;
    for (const b of atmos.beams) {
      const sp = b.userData.spot;
      b.material.uniforms.time.value = t;
      // Follow the lighting slider + theme spot colour
      b.material.uniforms.strength.value = 0.05 * k * Math.min(2, sp.intensity / 1.5);
      b.material.uniforms.color.value.copy(sp.color);
      b.visible = sp.visible !== false && sp.intensity > 0;
    }
    if (atmos.dust) {
      atmos.dust.material.uniforms.time.value = t;
      atmos.dust.material.uniforms.strength.value = 0.55 * k * lightingMul;
    }
  }

  /* ─── Contact shadows ─── */
  // Multiply-blended gradient strips, laid only where a wall actually stands
  // (probed with rays, so archways stay clear). Theme-independent: they
  // darken whatever the floor/wall colour is by the same ratio.
  const ContactShader = {
    uniforms: { depth: { value: 0.5 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float depth;
      varying vec2 vUv;
      void main() {
        // vUv.y = 0 at the junction, 1 at the far edge of the strip
        float a = pow(1.0 - vUv.y, 2.4) * depth;
        gl_FragColor = vec4(vec3(1.0 - a), 1.0);
      }`,
  };
  let contactGroup = null, contactTheme = null;
  const CONTACT_DEPTH = { duomo: 0.42, dark: 0.45, white: 0.22, ink: 0.18, spotlight: 0.35 };
  function buildContact() {
    const group = new THREE.Group();
    group.name = 'fx-contact';
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ContactShader.uniforms),
      vertexShader: ContactShader.vertexShader, fragmentShader: ContactShader.fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.MultiplyBlending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mat.uniforms.depth.value = CONTACT_DEPTH[theme] || 0.35;
    const rc = new THREE.Raycaster();
    scene.updateMatrixWorld();   // first frame: walls haven't been rendered yet
    const targets = wallMeshes.filter(m => m.isMesh);
    const STEP = 0.2, FLOOR_W = 0.55, CORNER_W = 0.5;
    const floorPos = [], floorUv = [], vertPos = [], vertUv = [];
    const quad = (P, U, a, b, c, d) => {   // a,b at junction (v=0); c,d far (v=1)
      P.push(...a, ...b, ...d, ...a, ...d, ...c);
      U.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    };
    const T = WALL_THICKNESS / 2;
    for (const id of Object.keys(ROOMS)) {
      const r = ROOMS[id];
      const x0 = r.cx - r.w / 2 + T, x1 = r.cx + r.w / 2 - T;
      const z0 = r.cz - r.d / 2 + T, z1 = r.cz + r.d / 2 - T;
      // Each edge: start point, direction along it, inward normal
      const edges = [
        { sx: x0, sz: z0, dx: 1, dz: 0, nx: 0, nz: 1, len: x1 - x0 },   // north wall
        { sx: x0, sz: z1, dx: 1, dz: 0, nx: 0, nz: -1, len: x1 - x0 },  // south
        { sx: x0, sz: z0, dx: 0, dz: 1, nx: 1, nz: 0, len: z1 - z0 },   // west
        { sx: x1, sz: z0, dx: 0, dz: 1, nx: -1, nz: 0, len: z1 - z0 },  // east
      ];
      for (const e of edges) {
        const n = Math.max(1, Math.round(e.len / STEP));
        const st = e.len / n;
        let runStart = -1;
        const flush = (i0, i1) => {
          const ax = e.sx + e.dx * i0 * st, az = e.sz + e.dz * i0 * st;
          const bx = e.sx + e.dx * i1 * st, bz = e.sz + e.dz * i1 * st;
          quad(floorPos, floorUv,
            [ax, 0.006, az], [bx, 0.006, bz],
            [ax + e.nx * FLOOR_W, 0.006, az + e.nz * FLOOR_W], [bx + e.nx * FLOOR_W, 0.006, bz + e.nz * FLOOR_W]);
          // the matching strip up the wall base (above the baseboard)
          quad(vertPos, vertUv,
            [ax + e.nx * 0.004, 0.0, az + e.nz * 0.004], [bx + e.nx * 0.004, 0.0, bz + e.nz * 0.004],
            [ax + e.nx * 0.004, 0.45, az + e.nz * 0.004], [bx + e.nx * 0.004, 0.45, bz + e.nz * 0.004]);
        };
        for (let i = 0; i < n; i++) {
          const mx = e.sx + e.dx * (i + 0.5) * st, mz = e.sz + e.dz * (i + 0.5) * st;
          rc.set(new THREE.Vector3(mx + e.nx * 0.5, 0.4, mz + e.nz * 0.5), new THREE.Vector3(-e.nx, 0, -e.nz));
          rc.far = 0.75;
          const wall = rc.intersectObjects(targets, false).length > 0;
          if (wall && runStart < 0) runStart = i;
          if (!wall && runStart >= 0) { flush(runStart, i); runStart = -1; }
        }
        if (runStart >= 0) flush(runStart, n);
      }
      // Corners: a vertical strip on each wall of each corner, full height
      const corners = [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]];
      for (const [cx, cz, sx, sz] of corners) {
        {
          // along X-wall (the one running in x at z=cz)
          vertPos.push(
            cx, 0, cz + sz * 0.004, cx, r.h, cz + sz * 0.004, cx + sx * CORNER_W, r.h, cz + sz * 0.004,
            cx, 0, cz + sz * 0.004, cx + sx * CORNER_W, r.h, cz + sz * 0.004, cx + sx * CORNER_W, 0, cz + sz * 0.004);
          vertUv.push(0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1);
          vertPos.push(
            cx + sx * 0.004, 0, cz, cx + sx * 0.004, r.h, cz, cx + sx * 0.004, r.h, cz + sz * CORNER_W,
            cx + sx * 0.004, 0, cz, cx + sx * 0.004, r.h, cz + sz * CORNER_W, cx + sx * 0.004, 0, cz + sz * CORNER_W);
          vertUv.push(0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1);
        }
      }
    }
    const vMat = mat.clone();
    vMat.userData.scale = 0.6;               // walls take a lighter touch than the floor
    mat.userData.scale = 1.0;
    for (const [P, U, M] of [[floorPos, floorUv, mat], [vertPos, vertUv, vMat]]) {
      if (!P.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      M.uniforms.depth.value = (CONTACT_DEPTH[theme] || 0.35) * M.userData.scale;
      const m = new THREE.Mesh(g, M);
      m.material.side = THREE.DoubleSide;
      m.renderOrder = 1.5;              // after the floor reflection
      m.frustumCulled = false;
      group.add(m);
    }
    contactGroup = group;
    contactTheme = theme;
    scene.add(group);
  }
  function syncContact() {
    const want = settings.contact && !(typeof mirrorWorld !== 'undefined' && mirrorWorld);
    if (want && !contactGroup && wallMeshes.length) buildContact();
    if (!contactGroup) return;
    contactGroup.visible = want;
    if (contactTheme !== theme) {
      contactTheme = theme;
      contactGroup.children.forEach(c => { c.material.uniforms.depth.value = (CONTACT_DEPTH[theme] || 0.35) * c.material.userData.scale; });
    }
  }

  /* ─── Film: vignette + grain overlay ─── */
  const VIGNETTE = { duomo: 0.55, dark: 0.55, spotlight: 0.5, white: 0.22, ink: 0.18 };
  let filmEl = null, filmTheme = null;
  function buildFilm() {
    const n = document.createElement('canvas');
    n.width = n.height = 160;
    const ctx = n.getContext('2d');
    const img = ctx.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 22;
    }
    ctx.putImageData(img, 0, 0);
    const css = document.createElement('style');
    css.textContent = `
      #fx-film { position: fixed; inset: 0; z-index: 1; pointer-events: none; }
      #fx-film .vig { position: absolute; inset: 0;
        background: radial-gradient(ellipse 78% 72% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,var(--vig, .5)) 100%); }
      #fx-film .grain { position: absolute; inset: -160px; opacity: .55;
        background-image: url(${n.toDataURL()});
        animation: fx-grain .5s steps(1) infinite; }
      @keyframes fx-grain {
        0% { transform: translate(0, 0); } 17% { transform: translate(-53px, 31px); }
        33% { transform: translate(41px, -67px); } 50% { transform: translate(-97px, -13px); }
        67% { transform: translate(71px, 89px); } 83% { transform: translate(-23px, 113px); } }
      @media (prefers-reduced-motion: reduce) { #fx-film .grain { animation: none; } }`;
    document.head.appendChild(css);
    filmEl = document.createElement('div');
    filmEl.id = 'fx-film';
    filmEl.innerHTML = '<div class="vig"></div><div class="grain"></div>';
    const stage = document.getElementById('stage');
    stage.parentNode.insertBefore(filmEl, stage.nextSibling);
  }
  function syncFilm() {
    if (settings.film && !filmEl) buildFilm();
    if (!filmEl) return;
    filmEl.style.display = settings.film ? '' : 'none';
    if (filmTheme !== theme) {
      filmTheme = theme;
      filmEl.style.setProperty('--vig', String(VIGNETTE[theme] != null ? VIGNETTE[theme] : 0.45));
    }
  }

  /* ─── Neon light spill ─── */
  // Soft additive light pools the neon would throw on the stone and marble.
  // Plant colours mirror the core's syncNeonPlants() table (by corner).
  const SpillShader = {
    uniforms: { color: { value: new THREE.Color() }, strength: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float strength;
      varying vec2 vUv;
      void main() {
        vec2 d = (vUv - 0.5) * 2.0;
        float r2 = dot(d, d);
        float a = exp(-r2 * 3.2) * (1.0 - smoothstep(0.8, 1.0, sqrt(r2)));
        gl_FragColor = vec4(color * a * strength, 1.0);
      }`,
  };
  const PLANT_GLOW = [   // [signX, signZ, colour]
    [-1, -1, 0x39ff8c], [1, -1, 0xff2e88], [-1, 1, 0x2fd4ff], [1, 1, 0x39ff8c],
  ];
  const SPILL = { duomo: 1.0, dark: 0.8, spotlight: 1.0, white: 0.35, ink: 0.35 };
  const spill = { group: null, plants: [], title: [] };
  function spillPlane(w, h, color, pos, rotY, rotX) {
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SpillShader.uniforms),
      vertexShader: SpillShader.vertexShader, fragmentShader: SpillShader.fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    m.uniforms.color.value.setHex(color);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.position.copy(pos);
    if (rotX) mesh.rotation.x = rotX;
    if (rotY) mesh.rotation.y = rotY;
    mesh.renderOrder = 1.6;
    return mesh;
  }
  function buildSpill() {
    const L = ROOMS.lobby;
    const g = new THREE.Group();
    g.name = 'fx-spill';
    const T = WALL_THICKNESS / 2 + 0.012;
    const xW = L.cx + L.w / 2 - T, zW = L.cz + L.d / 2 - T;
    for (const [sx, sz, col] of PLANT_GLOW) {
      const px = L.cx + sx * 7.8, pz = L.cz + sz * 4.6;
      const set = [
        [spillPlane(3.2, 3.2, col, new THREE.Vector3(px, 0.008, pz), 0, -Math.PI / 2), 0.20],
        // side wall (x = ±) and end wall (z = ±)
        [spillPlane(3.4, 3.0, col, new THREE.Vector3(sx * xW, 1.25, pz), -sx * Math.PI / 2, 0), 0.13],
        [spillPlane(3.4, 3.0, col, new THREE.Vector3(px, 1.25, sz * zW), sz > 0 ? Math.PI : 0, 0), 0.13],
      ];
      for (const [mesh, k] of set) { mesh.userData.k = k; g.add(mesh); spill.plants.push(mesh); }
    }
    // Title: violet wash on the stone around the sign
    const zN = L.cz - L.d / 2 + T;
    const tw = spillPlane(9.0, 4.2, 0x6f5cff, new THREE.Vector3(0, 4.55, zN), 0, 0);
    tw.userData.k = 0.16;
    g.add(tw); spill.title.push(tw);
    spill.group = g;
    scene.add(g);
  }
  function syncSpill() {
    const k = SPILL[theme] || 0;
    const want = settings.spill && k > 0 && !(typeof mirrorWorld !== 'undefined' && mirrorWorld);
    if (want && !spill.group && typeof ROOMS !== 'undefined' && ROOMS.lobby) buildSpill();
    if (!spill.group) return;
    spill.group.visible = want;
    if (!want) return;
    const plantsOn = typeof neonPlants !== 'undefined' && neonPlants && neonPlantMeshes.length > 0;
    for (const m of spill.plants) { m.visible = plantsOn; m.material.uniforms.strength.value = m.userData.k * k; }
    const titleOn = typeof neonTitle !== 'undefined' && neonTitle && lobbyTitleMesh;
    const flick = titleOn ? lobbyTitleMesh.material.opacity : 0;
    for (const m of spill.title) { m.visible = !!titleOn; m.material.uniforms.strength.value = m.userData.k * k * flick; }
  }

  function init() {
    if (ready) return;
    ready = true;
    window.addEventListener('resize', () => {
      if (composer) composer.setSize(window.innerWidth, window.innerHeight);
      resizeReflector();
      resizeBloom();
    });
  }

  function render(dt, now) {
    init();
    syncSurfaces();
    syncReflector();
    syncAtmos(now || performance.now());
    syncContact();
    syncFilm();
    syncSpill();
    if (settings.post) {
      if (!composer) composer = buildComposer();
      if (composer) {
        const on = settings.bloom ? renderBloom() : 0;
        finalPass.uniforms.bloomStrength.value = on ? BLOOM_STRENGTH : 0;
        if (on) finalPass.uniforms.tBloom.value = bloomPass.renderTargetsHorizontal[0].texture;
        composer.render();
        return;
      }
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
