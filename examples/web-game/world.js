// The 3D world of Firefly Lake: sky, water, banks with pine trees, rocks,
// lanterns, fireflies and the paper boat. Everything that costs GPU time is
// sized by a quality preset, so the same scene runs on a Fire TV Stick and a
// laptop. applyQuality() resizes it live.
import * as THREE from 'three';

export const LANES = [-3.2, 0, 3.2];
const PERIOD = 120; // the banks repeat every PERIOD units as the world scrolls
const SUN_DIR = new THREE.Vector3(-0.35, 0.22, -1).normalize();

const COLORS = {
  zenith: new THREE.Color('#1c1440'),
  horizon: new THREE.Color('#ff9a76'),
  haze: new THREE.Color('#e7788f'),
  sun: new THREE.Color('#ffd7a1'),
  deep: new THREE.Color('#1b1f4a'),
  shallow: new THREE.Color('#5a4d8c'),
  pine: new THREE.Color('#1f3b3a'),
  pine2: new THREE.Color('#2d4f43'),
  trunk: new THREE.Color('#3b2a2a'),
  rock: new THREE.Color('#4a3f5c'),
  hill: new THREE.Color('#2a1f45'),
  lantern: new THREE.Color('#ffc46b'),
  firefly: new THREE.Color('#ffe7a0'),
};

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} q  quality preset (see QUALITY in game.js)
 */
export function createWorld(renderer, q) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(COLORS.haze, q.fog);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 900);
  camera.position.set(0, 4.2, 8.5);
  camera.lookAt(0, 0.8, -6);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight('#ffc9a8', '#2a1a3a', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffb37a', 2.4);
  sun.position.set(-16, 22, -46); // from the low sun ahead of us: long shadows toward the camera
  sun.target.position.set(0, 0, -6);
  scene.add(sun, sun.target);

  // ---- sky ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uZenith: { value: COLORS.zenith }, uHorizon: { value: COLORS.horizon }, uSun: { value: COLORS.sun }, uSunDir: { value: SUN_DIR } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uHorizon, uSun, uSunDir;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.55));
          float d = max(dot(normalize(vDir), uSunDir), 0.0);
          col += uSun * (pow(d, 900.0) * 2.5 + pow(d, 24.0) * 0.45);
          col = mix(col, uHorizon * 0.8, smoothstep(0.0, -0.2, h));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // ---- distant hills (static: far enough that they need no parallax) ----
  const hillGeo = new THREE.IcosahedronGeometry(1, 1);
  const hillMat = new THREE.MeshStandardMaterial({ color: COLORS.hill, flatShading: true, roughness: 1 });
  const hills = new THREE.Group();
  const rand = mulberry32(7);
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(hillGeo, hillMat);
    const side = i % 2 ? 1 : -1;
    m.position.set(side * (40 + rand() * 120), -2, -180 - rand() * 160);
    m.scale.set(30 + rand() * 40, 14 + rand() * 26, 30 + rand() * 30);
    hills.add(m);
  }
  scene.add(hills);

  // ---- water ----
  const waterUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uScroll: { value: 0 },
      uDeep: { value: COLORS.deep },
      uShallow: { value: COLORS.shallow },
      uSun: { value: COLORS.sun },
      uSky: { value: COLORS.horizon },
      uSunDir: { value: SUN_DIR },
    },
  ]);
  const waterMat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: waterUniforms,
    vertexShader: /* glsl */ `
      uniform float uTime, uScroll;
      varying vec3 vWorld;
      varying float vWave;
      #include <fog_pars_vertex>
      void main() {
        vec3 p = position;
        float z = p.z - uScroll;
        float w = sin(p.x * 0.35 + uTime * 1.3) * 0.14 + sin(z * 0.25 + uTime * 0.9) * 0.16 + sin((p.x + z) * 0.6 + uTime * 2.1) * 0.05;
        p.y += w;
        vWave = w;
        vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uDeep, uShallow, uSun, uSky, uSunDir;
      varying vec3 vWorld;
      varying float vWave;
      #include <fog_pars_fragment>
      void main() {
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (n.y < 0.0) n = -n;
        vec3 v = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        vec3 col = mix(uDeep, uShallow, clamp(vWave * 1.6 + 0.45, 0.0, 1.0));
        vec3 r = reflect(-v, n);
        float s = max(dot(r, uSunDir), 0.0);
        col += uSun * (pow(s, 260.0) * 2.2 + pow(s, 14.0) * 0.12); // glints + a soft golden path
        col += uSky * fres * 0.2;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  /** @type {THREE.Mesh} */
  let water = new THREE.Mesh(new THREE.BufferGeometry(), waterMat);
  scene.add(water);

  // ---- banks ----
  const bankGeo = new THREE.PlaneGeometry(80, PERIOD * 3, 1, 1).rotateX(-Math.PI / 2);
  const bankMat = new THREE.MeshStandardMaterial({ color: '#2c2a3f', roughness: 1 });
  for (const side of [-1, 1]) {
    const bank = new THREE.Mesh(bankGeo, bankMat);
    bank.position.set(side * (11.5 + 40), 0.35, -PERIOD);
    bank.receiveShadow = true;
    bank.userData.shadowReceiver = true;
    scene.add(bank);
  }

  // ---- trees: two instanced meshes (foliage + trunk) on a looping strip ----
  const foliageGeo = new THREE.ConeGeometry(0.9, 2.8, 6, 1).translate(0, 1.9, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 0.7, 5).translate(0, 0.35, 0);
  const foliageMat = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 0.95 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: COLORS.trunk, roughness: 1 });
  const treeGroup = new THREE.Group();
  scene.add(treeGroup);
  /** @type {THREE.InstancedMesh | null} */
  let foliage = null;
  /** @type {THREE.InstancedMesh | null} */
  let trunks = null;

  function buildTrees(count, shadows) {
    if (foliage) {
      treeGroup.remove(foliage, trunks);
      foliage.dispose();
      trunks.dispose();
    }
    foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, count * 2);
    trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count * 2);
    const r = mulberry32(42);
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const x = side * (12.2 + Math.pow(r(), 1.6) * 36);
      const z = -r() * PERIOD;
      const s = 0.7 + r() * 0.9;
      quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r() * Math.PI);
      scl.set(s, s * (0.85 + r() * 0.5), s);
      col.copy(COLORS.pine).lerp(COLORS.pine2, r());
      // Two copies, PERIOD apart, so the strip loops seamlessly.
      for (let k = 0; k < 2; k++) {
        pos.set(x, 0.35, z - k * PERIOD);
        m.compose(pos, quat, scl);
        foliage.setMatrixAt(i * 2 + k, m);
        trunks.setMatrixAt(i * 2 + k, m);
        foliage.setColorAt(i * 2 + k, col);
      }
    }
    foliage.castShadow = trunks.castShadow = shadows;
    foliage.frustumCulled = trunks.frustumCulled = false;
    treeGroup.add(foliage, trunks);
  }

  // ---- fireflies: one Points draw, animated in the vertex shader ----
  const fireflyMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScroll: { value: 0 }, uColor: { value: COLORS.firefly }, uPixel: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uScroll, uPixel;
      attribute float aSeed;
      varying float vBlink;
      void main() {
        vec3 p = position;
        p.z = mod(p.z + uScroll, ${PERIOD.toFixed(1)}) - ${(PERIOD * 0.85).toFixed(1)};
        p.x += sin(uTime * 0.7 + aSeed * 6.28) * 0.6;
        p.y += sin(uTime * 1.1 + aSeed * 12.0) * 0.35;
        vBlink = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed * 2.0) + aSeed * 40.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uPixel * (5.0 + aSeed * 5.0) * (30.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vBlink;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(uColor * a * vBlink, a * vBlink);
      }`,
  });
  /** @type {THREE.Points | null} */
  let fireflies = null;

  function buildFireflies(count) {
    if (fireflies) {
      scene.remove(fireflies);
      fireflies.geometry.dispose();
    }
    const r = mulberry32(99);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const overWater = r() < 0.35;
      pos[i * 3] = overWater ? (r() - 0.5) * 20 : (r() < 0.5 ? -1 : 1) * (11 + r() * 30);
      pos[i * 3 + 1] = 0.6 + r() * (overWater ? 2.5 : 5);
      pos[i * 3 + 2] = r() * PERIOD;
      seed[i] = r();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    fireflies = new THREE.Points(g, fireflyMat);
    fireflies.frustumCulled = false;
    scene.add(fireflies);
  }

  // ---- the boat ----
  const boat = new THREE.Group();
  const hullGeo = new THREE.BoxGeometry(1.2, 0.4, 2.3, 2, 1, 3);
  {
    const p = hullGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      const y = p.getY(i);
      let sx = 1;
      if (z < -0.3) sx = 0.25; // pointed bow
      if (y < 0) sx *= 0.7; // narrower keel
      p.setX(i, p.getX(i) * sx);
      if (z < -0.3 || z > 0.9) p.setY(i, y + 0.18); // raised bow and stern
    }
    hullGeo.computeVertexNormals();
  }
  const hull = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: '#f4e6d8', flatShading: true, roughness: 0.8 }));
  hull.position.y = 0.2;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.8, 5), new THREE.MeshStandardMaterial({ color: '#6b4b3e' }));
  mast.position.set(0, 1.1, 0.1);
  const sailGeo = new THREE.BufferGeometry();
  // A triangle sail across the boat (in the XY plane), so it shows from behind.
  sailGeo.setAttribute('position', new THREE.Float32BufferAttribute([0.03, 1.95, 0.12, 0.03, 0.5, 0.12, 0.95, 0.5, 0.32], 3));
  sailGeo.computeVertexNormals();
  const sail = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({ color: '#ffb3c1', side: THREE.DoubleSide, roughness: 0.6 }));
  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: COLORS.lantern }));
  lantern.position.set(0, 2.05, 0.1);
  boat.add(hull, mast, sail, lantern);
  const boatLight = new THREE.PointLight('#ffb35c', 6, 9, 1.6);
  boatLight.position.set(0, 2.2, 0.3);
  scene.add(boat);
  boat.traverse((o) => {
    if (o.isMesh && o !== lantern) o.castShadow = true;
  });

  // ---- pools: rocks and lanterns ----
  const glow = makeGlowTexture();
  const rockGeo = new THREE.IcosahedronGeometry(0.95, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: COLORS.rock, flatShading: true, roughness: 0.9 });
  const rocks = [];
  for (let i = 0; i < 18; i++) {
    const m = new THREE.Mesh(rockGeo, rockMat);
    m.visible = false;
    m.castShadow = true;
    scene.add(m);
    rocks.push({ mesh: m, lane: 0, active: false });
  }
  const lanternGeo = new THREE.SphereGeometry(0.32, 12, 8);
  const lanternMat = new THREE.MeshBasicMaterial({ color: COLORS.lantern });
  const haloMat = new THREE.SpriteMaterial({ map: glow, color: '#ffb35c', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const lanterns = [];
  for (let i = 0; i < 16; i++) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(lanternGeo, lanternMat));
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(2.4);
    g.add(halo);
    g.visible = false;
    scene.add(g);
    lanterns.push({ obj: g, lane: 0, active: false });
  }
  // Busy scene: extra coloured point lights drifting over the lake.
  const extraLights = [];
  for (let i = 0; i < 4; i++) {
    const l = new THREE.PointLight(['#ff6fa8', '#6fc8ff', '#ffd36f', '#9b7bff'][i], 8, 14, 1.4);
    l.visible = false;
    scene.add(l);
    extraLights.push(l);
  }

  let current = null;
  /** Rebuilds what the quality preset sizes. Shadows and light counts recompile shaders. */
  function applyQuality(next) {
    const shadowsChanged = !current || current.shadows !== next.shadows;
    if (!current || current.water[0] !== next.water[0] || current.water[1] !== next.water[1]) {
      water.geometry.dispose();
      water.geometry = new THREE.PlaneGeometry(26, PERIOD * 2.6, next.water[0], next.water[1]).rotateX(-Math.PI / 2).translate(0, 0, -PERIOD * 1.1);
    }
    if (!current || current.trees !== next.trees || shadowsChanged) buildTrees(next.trees, next.shadows > 0);
    if (!current || current.fireflies !== next.fireflies) buildFireflies(next.fireflies);
    renderer.shadowMap.enabled = next.shadows > 0;
    sun.castShadow = next.shadows > 0;
    if (next.shadows > 0) {
      sun.shadow.mapSize.set(next.shadows, next.shadows);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      const c = sun.shadow.camera;
      c.left = -22;
      c.right = 22;
      c.top = 30;
      c.bottom = -30;
      c.near = 1;
      c.far = 120;
      c.updateProjectionMatrix();
      sun.shadow.bias = -0.0008;
    }
    if (next.boatLight && !boatLight.parent) scene.add(boatLight);
    if (!next.boatLight && boatLight.parent) scene.remove(boatLight);
    extraLights.forEach((l, i) => (l.visible = i < next.extraLights));
    scene.fog.density = next.fog;
    if (shadowsChanged || !current || current.extraLights !== next.extraLights || current.boatLight !== next.boatLight) {
      scene.traverse((o) => {
        if (o.material) o.material.needsUpdate = true;
      });
    }
    current = { ...next };
  }

  applyQuality(q);

  return {
    scene,
    camera,
    boat,
    rocks,
    lanterns,
    applyQuality,
    /** Moves the looping parts of the world by `dz` and animates time-based effects. */
    tick(time, dz, pixelRatio) {
      waterUniforms.uTime.value = time;
      waterUniforms.uScroll.value += dz;
      fireflyMat.uniforms.uTime.value = time;
      fireflyMat.uniforms.uScroll.value += dz;
      fireflyMat.uniforms.uPixel.value = pixelRatio;
      treeGroup.position.z = (treeGroup.position.z + dz) % PERIOD;
      boatLight.position.set(boat.position.x, boat.position.y + 2.2, 0.3);
      extraLights.forEach((l, i) => {
        if (!l.visible) return;
        l.position.set(Math.sin(time * 0.5 + i * 1.7) * 8, 2.2 + Math.sin(time * 1.3 + i) * 0.6, -8 - i * 9 + Math.cos(time * 0.4 + i) * 4);
      });
      for (const l of lanterns) if (l.active) l.obj.children[0].scale.setScalar(1 + Math.sin(time * 6 + l.obj.position.z) * 0.08);
    },
    resize() {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    },
  };
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,220,160,0.6)');
  grad.addColorStop(1, 'rgba(255,180,100,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Small seeded PRNG so the world looks the same on every launch. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
