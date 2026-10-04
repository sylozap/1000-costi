// 3D-стол с кубиками. Результат приходит с сервера, анимация лишь «доводит» кубик до нужной грани.
import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { MAP_BUILDERS } from './maps.js';

const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};
// Порядок граней BoxGeometry: +x, -x, +y, -y, +z, -z (противоположные в сумме дают 7)
const FACE_ORDER = [2, 5, 1, 6, 3, 4];
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);
const qa = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
// поворот, при котором грань со значением v смотрит вверх (+y)
const FACE_UP = {
  1: new THREE.Quaternion(),
  6: qa(AX, Math.PI),
  2: qa(AZ, Math.PI / 2),
  5: qa(AZ, -Math.PI / 2),
  3: qa(AX, -Math.PI / 2),
  4: qa(AX, Math.PI / 2),
};

const AREA = { x: 2.5, z: 1.45 };
const DIE = 1;
const HALF = DIE / 2;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function easeOutBounce(x) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const IMPACTS = [[1 / 2.75, 1], [2 / 2.75, 0.45], [2.5 / 2.75, 0.2]];

const WHITE = ['#ffffff', '#dcdcdc'];
export const SKINS = {
  ivory: { bg: ['#fffdf6', '#e9e0c8'], pip: ['#3a3a3a', '#0b0b0b'], one: ['#ff5a4f', '#a3150f'], metal: 0, rough: 0.35 },
  gold: { bg: ['#fff1a8', '#d9a520'], pip: ['#5a3a00', '#241600'], one: ['#ff5a4f', '#8a0f08'], metal: 0.55, rough: 0.22 },
  pink: { bg: ['#ffe6f1', '#f29cc3'], pip: ['#a3245a', '#5c0f31'], one: ['#ff3b7a', '#b0103f'], metal: 0.25, rough: 0.2, pattern: 'pearl' },
  onyx: { bg: ['#3a3a40', '#0c0c0e'], pip: ['#ffe08a', '#b8860b'], one: ['#ffe08a', '#b8860b'], metal: 0.3, rough: 0.22 },
  ruby: { bg: ['#ff5c6c', '#8a0c18'], pip: WHITE, one: WHITE, metal: 0.15, rough: 0.16 },
  sapphire: { bg: ['#5cb0ff', '#0b3d91'], pip: WHITE, one: WHITE, metal: 0.15, rough: 0.16 },
  emerald: { bg: ['#5cefa0', '#0b6b3a'], pip: WHITE, one: WHITE, metal: 0.15, rough: 0.16 },
  marble: { bg: ['#ffffff', '#d9d9de'], pip: ['#2b2b30', '#000000'], one: ['#2b2b30', '#000000'], metal: 0.05, rough: 0.15, pattern: 'marble' },
  wood: { bg: ['#d9a066', '#9a5f2c'], pip: ['#3b220e', '#1a0d04'], one: ['#3b220e', '#1a0d04'], metal: 0, rough: 0.55, pattern: 'wood' },
  neon: { bg: ['#1c1c33', '#07070f'], pip: ['#a8fff7', '#00e5d4'], one: ['#ff9cf0', '#ff2bd6'], metal: 0.1, rough: 0.3, glow: true },
  ice: { bg: ['#f2fdff', '#93d3ec'], pip: ['#1d6fb8', '#0b3d6e'], one: ['#1d6fb8', '#0b3d6e'], metal: 0.1, rough: 0.08, pattern: 'ice' },
  candy: { bg: ['#ffffff', '#ffe9f2'], pip: ['#e3266f', '#9c0f45'], one: ['#e3266f', '#9c0f45'], metal: 0, rough: 0.25, pattern: 'candy' },
  bone: { bg: ['#f4ebd3', '#c4b38a'], pip: ['#4a3420', '#21150a'], one: ['#8a2a14', '#4a0f05'], metal: 0, rough: 0.7, pattern: 'bone' },
};

function skinPattern(g, s, kind, v) {
  const rnd = mulberry32(v * 97 + kind.length);
  if (kind === 'marble') {
    for (let i = 0; i < 7; i++) {
      g.strokeStyle = `rgba(90,90,105,${0.15 + rnd() * 0.25})`;
      g.lineWidth = 1 + rnd() * 3;
      g.beginPath();
      g.moveTo(rnd() * s, 0);
      g.bezierCurveTo(rnd() * s, s * 0.3, rnd() * s, s * 0.7, rnd() * s, s);
      g.stroke();
    }
  } else if (kind === 'wood') {
    for (let i = 0; i < 22; i++) {
      g.strokeStyle = `rgba(90,45,10,${0.15 + rnd() * 0.25})`;
      g.lineWidth = 1 + rnd() * 2.5;
      g.beginPath();
      const y0 = rnd() * s, ph = rnd() * 6;
      for (let x = 0; x <= s; x += 8) g.lineTo(x, y0 + Math.sin(x * 0.03 + ph) * 5);
      g.stroke();
    }
  } else if (kind === 'ice') {
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) {
      let x = rnd() * s, y = rnd() * s;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (rnd() - 0.5) * 90;
        y += (rnd() - 0.5) * 90;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  } else if (kind === 'candy') {
    g.fillStyle = 'rgba(255,120,170,0.35)';
    for (let k = -s; k < s * 2; k += 46) {
      g.beginPath();
      g.moveTo(k, 0); g.lineTo(k + 20, 0); g.lineTo(k + 20 - s, s); g.lineTo(k - s, s);
      g.fill();
    }
  } else if (kind === 'pearl') {
    const sh = g.createLinearGradient(0, 0, s, s);
    sh.addColorStop(0, 'rgba(255,255,255,0.45)');
    sh.addColorStop(0.35, 'rgba(200,220,255,0.18)');
    sh.addColorStop(0.65, 'rgba(255,210,240,0.25)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sh;
    g.fillRect(0, 0, s, s);
  } else if (kind === 'bone') {
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(110,80,40,${rnd() * 0.18})`;
      g.fillRect(rnd() * s, rnd() * s, 2 + rnd() * 3, 2 + rnd() * 3);
    }
  }
}

/** Грань кубика на canvas 256×256. */
export function faceCanvas(v, skin = 'ivory') {
  const sk = SKINS[skin] || SKINS.ivory;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s * 0.35, s * 0.3, 10, s / 2, s / 2, s * 0.75);
  grad.addColorStop(0, sk.bg[0]);
  grad.addColorStop(1, sk.bg[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  if (sk.pattern) skinPattern(g, s, sk.pattern, v);
  for (const [px, py] of PIPS[v]) {
    const r = v === 1 ? 34 : 22;
    const x = px * s, y = py * s;
    const pg = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    const col = v === 1 ? sk.one : sk.pip;
    pg.addColorStop(0, col[0]);
    pg.addColorStop(1, col[1]);
    g.fillStyle = pg;
    if (sk.glow) {
      g.shadowColor = col[1];
      g.shadowBlur = 18;
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
  }
  return c;
}

function faceTexture(v, renderer, skin = 'ivory') {
  const tex = new THREE.CanvasTexture(faceCanvas(v, skin));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function feltTexture() {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#1f6b44';
  g.fillRect(0, 0, s, s);
  const img = g.getImageData(0, 0, s, s);
  const rnd = mulberry32(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const v = g.createRadialGradient(s / 2, s / 2, s * 0.12, s / 2, s / 2, s * 0.5);
  v.addColorStop(0, 'rgba(255,255,220,0.10)');
  v.addColorStop(0.6, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(4,24,14,0.85)');
  g.fillStyle = v;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DiceTable {
  constructor(el, hooks = {}) {
    this.el = el;
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x0b2416);
    el.appendChild(this.renderer.domElement);
    // после потери контекста (фон, нехватка памяти) three.js восстанавливает ресурсы — нужно перерисовать
    this.renderer.domElement.addEventListener('webglcontextrestored', () => { this.dirty = true; });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.target = new THREE.Vector3(0, 0, 0.15);
    this.camDir = new THREE.Vector3(0, 0.86, 0.51).normalize();
    this.camShake = 0;

    this.scene.add(new THREE.HemisphereLight(0xfff4dc, 0x0a2a18, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(2.5, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 25 });
    sun.shadow.radius = 4;
    this.scene.add(sun);

    this.hemi = this.scene.children[0];
    this.sun = sun;
    this.feltTex = feltTexture();
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ map: this.feltTex, roughness: 1, metalness: 0 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);
    this.table = table;
    this.mapId = 'felt';
    this.env = null;

    const textures = FACE_ORDER.map((v) => faceTexture(v, this.renderer));
    this.skinTextures = { ivory: textures };
    this.skin = 'ivory';
    const geo = new RoundedBoxGeometry(DIE, DIE, DIE, 5, 0.13);
    this.dice = [];
    for (let i = 0; i < 5; i++) {
      const mats = textures.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.35, metalness: 0 }));
      const mesh = new THREE.Mesh(geo, mats);
      mesh.castShadow = true;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 0.86, 48),
        new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.012;
      this.scene.add(mesh, ring);
      this.dice.push({ mesh, ring, mats });
    }

    this.anim = null;
    this.dirty = true;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(el);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    this.showStatic([1, 5, 1, 5, 1], [], 12345);
  }

  /** Карта стола: 'felt' (сукно) или одна из MAP_BUILDERS. */
  setMap(id) {
    if (id === this.mapId || (id !== 'felt' && !MAP_BUILDERS[id])) return;
    if (this.env) {
      this.scene.remove(this.env.group);
      this.env.group.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [].concat(o.material || [])) {
          m.map?.dispose();
          m.dispose();
        }
      });
      if (this.env.floor) this.env.floor.dispose();
    }
    const env = id === 'felt' ? null : MAP_BUILDERS[id](this.renderer);
    const light = env?.light || { sky: 0xfff4dc, ground: 0x0a2a18, hemi: 1.1, sun: 0xffffff, sunI: 1.9 };
    this.hemi.color.setHex(light.sky);
    this.hemi.groundColor.setHex(light.ground);
    this.hemi.intensity = light.hemi;
    this.sun.color.setHex(light.sun);
    this.sun.intensity = light.sunI;
    this.table.visible = !env || env.floor !== null;
    this.table.material.map = env?.floor || this.feltTex;
    this.table.material.needsUpdate = true;
    this.renderer.setClearColor(env ? env.clear : 0x0b2416);
    if (env) this.scene.add(env.group);
    this.env = env;
    this.mapId = id;
    this.dirty = true;
  }

  /** Куда кубик, летящий из start в end, врежется в стенку карты (или null). */
  _wallHit(start, end) {
    const w = this.env?.wall;
    if (!w) return null;
    let dx = end.x - start.x, dz = end.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    let t = null;
    if (w.type === 'circle') {
      const b = end.x * dx + end.z * dz;
      const c = end.x * end.x + end.z * end.z - w.r * w.r;
      if (c < -0.3) t = -b + Math.sqrt(b * b - c);
    } else if (w.type === 'box') {
      const tx = dx ? (Math.sign(dx) * w.hx - end.x) / dx : Infinity;
      const tz = dz ? (Math.sign(dz) * w.hz - end.z) / dz : Infinity;
      t = Math.min(tx, tz);
    } else if (w.type === 'back' && dz < -0.2) {
      t = (w.z - end.z) / dz;
    }
    if (t === null || !(t > 0.35) || t > 7) return null;
    return new THREE.Vector3(end.x + dx * t, HALF, end.z + dz * t);
  }

  /** Скин кубиков (см. SKINS): обычные, золотые, розовые и т.д. */
  setSkin(name) {
    if (!SKINS[name] || name === this.skin) return;
    if (!this.skinTextures[name]) {
      this.skinTextures[name] = FACE_ORDER.map((v) => faceTexture(v, this.renderer, name));
    }
    const tex = this.skinTextures[name];
    for (const d of this.dice) {
      d.mats.forEach((m, i) => {
        m.map = tex[i];
        m.metalness = SKINS[name].metal;
        m.roughness = SKINS[name].rough;
        m.needsUpdate = true;
      });
    }
    this.skin = name;
    this.dirty = true;
  }

  _resize() {
    const w = this.el.clientWidth || 300;
    const h = this.el.clientHeight || 220;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // подбираем расстояние так, чтобы зона броска влезала по ширине и высоте
    const vHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const hHalf = vHalf * this.camera.aspect;
    const needW = AREA.x + 1.6; // запас на перспективу: ближние кубики шире
    const needH = (AREA.z + 1.0) * 0.9;
    this.camDist = Math.max(needW / hHalf, needH / vHalf, 6.5);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  _layout(n, rnd) {
    const pts = [];
    for (let tries = 0; pts.length < n && tries < 400; tries++) {
      const p = { x: (rnd() * 2 - 1) * AREA.x, z: (rnd() * 2 - 1) * AREA.z };
      if (pts.every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 1.5)) pts.push(p);
    }
    while (pts.length < n) pts.push({ x: -2 + pts.length, z: 0 }); // запасной ряд
    return pts;
  }

  _plan(values, seed) {
    const rnd = mulberry32(seed);
    const pts = this._layout(values.length, rnd);
    return values.map((v, i) => {
      const yaw = qa(AY, rnd() * Math.PI * 2);
      const qf = new THREE.Quaternion().multiplyQuaternions(yaw, FACE_UP[v]);
      const end = new THREE.Vector3(pts[i].x, HALF, pts[i].z);
      const start = new THREE.Vector3(pts[i].x * 0.35 + (rnd() - 0.5) * 2.2, 2.4 + rnd() * 1.4, 4.6 + rnd() * 1.2);
      const dx = end.x - start.x, dz = end.z - start.z;
      const axis = new THREE.Vector3(dz, (rnd() - 0.5) * 0.8, -dx).normalize();
      const via = this._wallHit(start, end);
      let kb = 0;
      if (via) {
        const l1 = Math.hypot(via.x - start.x, via.z - start.z);
        kb = l1 / (l1 + via.distanceTo(end));
      }
      return {
        qf, end, start, axis, via, kb, hitWall: false,
        spin: 9 + rnd() * 7,
        delay: i * 0.05 + rnd() * 0.08,
        dur: 1.05 + rnd() * 0.3,
        impacts: 0,
      };
    });
  }

  _clearHighlight() {
    for (const d of this.dice) {
      d.ring.material.opacity = 0;
      for (const m of d.mats) {
        m.color.setHex(0xffffff);
        m.emissive.setHex(0x000000);
      }
    }
  }

  _highlight(n, scoring, mode) {
    for (let i = 0; i < n; i++) {
      const d = this.dice[i];
      const good = scoring.includes(i);
      for (const m of d.mats) {
        if (mode === 'zero') m.color.setHex(0xff9a90);
        else if (mode === 'plain') m.color.setHex(0xffffff);
        else if (good) {
          m.color.setHex(0xffffff);
          m.emissive.setHex(0x3d2c00);
        } else m.color.setHex(0x7d7d7d);
      }
      d.ring.material.opacity = mode === 'score' && good ? 0.9 : 0;
      d.ring.position.x = d.mesh.position.x;
      d.ring.position.z = d.mesh.position.z;
    }
    this.dirty = true;
  }

  _modeFor(roll) {
    if (roll.kind === 'order') return 'plain';
    return roll.points === 0 ? 'zero' : 'score';
  }

  showStatic(values, scoring, seed, roll = null) {
    this.anim = null;
    const plan = this._plan(values, seed);
    this.dice.forEach((d, i) => {
      const visible = i < values.length;
      d.mesh.visible = visible;
      d.ring.visible = visible;
      if (!visible) return;
      d.mesh.position.copy(plan[i].end);
      d.mesh.quaternion.copy(plan[i].qf);
    });
    this._clearHighlight();
    if (roll) this._highlight(values.length, scoring, this._modeFor(roll));
    this.dirty = true;
  }

  /** Анимирует бросок; промис завершается, когда кубики легли. */
  throwDice(roll) {
    const values = roll.dice;
    const plan = this._plan(values, roll.seed);
    this._clearHighlight();
    this.dice.forEach((d, i) => {
      const visible = i < values.length;
      d.mesh.visible = visible;
      d.ring.visible = visible;
      if (visible) {
        d.mesh.position.copy(plan[i].start);
        d.mesh.quaternion.copy(plan[i].qf);
      }
    });
    if (this.anim) this.anim.resolve();
    return new Promise((resolve) => {
      this.anim = { plan, t0: performance.now(), resolve, roll };
      this.hooks.onThrow?.(values.length);
    });
  }

  _step(now) {
    const a = this.anim;
    const el = (now - a.t0) / 1000;
    let done = true;
    a.plan.forEach((p, i) => {
      const d = this.dice[i];
      const t = Math.min(1, Math.max(0, (el - p.delay) / p.dur));
      if (t < 1) done = false;
      const y = HALF + (p.start.y - HALF) * (1 - easeOutBounce(t));
      if (p.via) {
        // удар о стенку совпадает с первым касанием пола, потом кубик откатывается к своему месту
        const tb = IMPACTS[0][0];
        if (t < tb) {
          const k = t / tb;
          d.mesh.position.set(p.start.x + (p.via.x - p.start.x) * k, y, p.start.z + (p.via.z - p.start.z) * k);
        } else {
          const k = easeOutCubic(Math.min(1, (t - tb) / (0.85 - tb)));
          d.mesh.position.set(p.via.x + (p.end.x - p.via.x) * k, y, p.via.z + (p.end.z - p.via.z) * k);
          if (!p.hitWall) {
            p.hitWall = true;
            this.env?.onWall?.(p.via);
            this.hooks.onWall?.(i);
          }
        }
      } else {
        const k = easeOutCubic(Math.min(1, t / 0.85));
        d.mesh.position.set(
          p.start.x + (p.end.x - p.start.x) * k,
          y,
          p.start.z + (p.end.z - p.start.z) * k,
        );
      }
      const r = easeOutCubic(Math.min(1, t / 0.92));
      const spinQ = qa(p.axis, -p.spin * (1 - r));
      d.mesh.quaternion.multiplyQuaternions(spinQ, p.qf);
      while (p.impacts < IMPACTS.length && t >= IMPACTS[p.impacts][0]) {
        this.hooks.onImpact?.(IMPACTS[p.impacts][1], i);
        p.impacts++;
      }
    });
    if (done) {
      const roll = a.roll;
      this.anim = null;
      const mode = this._modeFor(roll);
      this._highlight(roll.dice.length, roll.scoring || [], mode);
      if (mode === 'zero') this.camShake = 1;
      a.resolve();
    }
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (this.anim) this._step(now);
    if (this.env?.update && this.env.update(now)) this.dirty = true;
    let shakeX = 0;
    if (this.camShake > 0) {
      this.dirty = true;
      this.camShake = Math.max(0, this.camShake - 0.045);
      shakeX = Math.sin(now / 22) * 0.12 * this.camShake;
    }
    if (!this.anim && !this.dirty) return;
    this.camera.position.copy(this.target).addScaledVector(this.camDir, this.camDist);
    this.camera.position.x += shakeX;
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }
}
