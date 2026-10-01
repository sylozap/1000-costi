// 3D-стол с кубиками. Результат приходит с сервера, анимация лишь «доводит» кубик до нужной грани.
import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';

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

function faceTexture(v, renderer) {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s * 0.35, s * 0.3, 10, s / 2, s / 2, s * 0.75);
  grad.addColorStop(0, '#fffdf6');
  grad.addColorStop(1, '#e9e0c8');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  for (const [px, py] of PIPS[v]) {
    const r = v === 1 ? 34 : 22;
    const x = px * s, y = py * s;
    const pg = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    if (v === 1) {
      pg.addColorStop(0, '#ff5a4f');
      pg.addColorStop(1, '#a3150f');
    } else {
      pg.addColorStop(0, '#3a3a3a');
      pg.addColorStop(1, '#0b0b0b');
    }
    g.fillStyle = pg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
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

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 1, metalness: 0 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);

    const textures = FACE_ORDER.map((v) => faceTexture(v, this.renderer));
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
      return {
        qf, end, start, axis,
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
      const k = easeOutCubic(Math.min(1, t / 0.85));
      d.mesh.position.set(
        p.start.x + (p.end.x - p.start.x) * k,
        HALF + (p.start.y - HALF) * (1 - easeOutBounce(t)),
        p.start.z + (p.end.z - p.start.z) * k,
      );
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
