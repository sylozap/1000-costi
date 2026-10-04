// Карты (столы) для 3D-сцены. Всё рисуется кодом: текстуры на canvas, декор из простых фигур.
//
// Мировые единицы: кубик = 1. Кубики приземляются в зоне x ∈ [−2.5; 2.5], z ∈ [−1.45; 1.45] —
// декор ставим за её пределами. Текстура пола — квадрат 16×16 единиц (1024 px, 64 px на единицу)
// вокруг центра; сцена сама обрезает её под форму пола карты (floorShape).
//
// Что возвращает построитель карты:
//   floor       текстура пола (null — пола нет, как в космосе)
//   floorShape  { w, d, cx, cz } прямоугольник или { sides, r } многоугольник
//   ground      цвет земли вокруг (null — нет), groundY — её высота, groundTex — текстура
//   clear, fog  цвет фона и туман [цвет, ближе, дальше]
//   light       цвета и сила света
//   view        общий план камеры: { r, z, el }
//   group       декор; объекты с userData.heavy прячутся на слабых устройствах
//   wall        стенка для отскока кубиков; onWall — реакция декора на удар
//   update(now) анимации; true — кадр нужно перерисовать
import * as THREE from './vendor/three.module.min.js';

const PX = 64;
const SIZE = 1024;
const u = (x) => (x + 8) * PX; // мировая координата → пиксель текстуры пола

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w = SIZE, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function grain(g, w, h, amp, seed) {
  const img = g.getImageData(0, 0, w, h);
  const rnd = rng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * amp;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function vignette(g, inner, outer, color, w = SIZE, h = SIZE) {
  const v = g.createRadialGradient(w / 2, h / 2 - 20, inner, w / 2, h / 2, outer);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, color);
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
}

function texture(c, renderer, repeat = null) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o });
const glow = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });

function mesh(geo, material, [x, y, z] = [0, 0, 0], shadow = true) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

const heavy = (o) => {
  o.userData.heavy = true;
  o.castShadow = false;
  return o;
};

function poly(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
}

/** Вершины правильного восьмиугольника с плоскими сторонами по осям (в пикселях или единицах). */
function octagon(cx, cy, apothem) {
  const r = apothem / Math.cos(Math.PI / 8);
  return [...Array(8)].map((_, k) => {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** Текстура с надписью (вывески, экраны, блокнот). */
function label(renderer, w, h, draw) {
  const [c, g] = canvas(w, h);
  draw(g, w, h);
  return texture(c, renderer);
}

/** Колебание объекта после удара кубика: смещение вдоль нормали с затуханием. */
function wobble(obj, normal, amp) {
  obj.userData.wob = { t0: performance.now(), base: obj.userData.wob?.base || obj.position.clone(), normal, amp };
}

function updateWobbles(group, now) {
  let busy = false;
  group.traverse((o) => {
    const w = o.userData.wob;
    if (!w) return;
    const t = (now - w.t0) / 1000;
    if (t > 0.9) {
      o.position.copy(w.base);
      delete o.userData.wob;
      return;
    }
    busy = true;
    const k = Math.sin(t * 38) * Math.exp(-t * 6) * w.amp;
    o.position.copy(w.base).addScaledVector(w.normal, k);
  });
  return busy;
}

/** Собирает анимации карты; в экономном режиме тяжёлые анимации не крутятся. */
function animator(quality) {
  const list = [];
  return {
    add(fn, isHeavy = false) {
      if (!(isHeavy && quality === 'low')) list.push(fn);
    },
    run(now) {
      let busy = false;
      for (const fn of list) busy = fn(now) || busy;
      return busy;
    },
  };
}

// ---------- общий декор ----------

/** Зрители на ярусах вокруг арены (InstancedMesh — дёшево даже для сотен фигур). */
function crowd(group, { shape = 'circle', r0, rows, step = 0.95, rise = 0.5, y0 = 0, seed = 1, density = 1.6, gapFront = 0 }) {
  const rnd = rng(seed);
  const pts = [];
  const tierMat = mat(0x16181f, { roughness: 0.9 });
  for (let i = 0; i < rows; i++) {
    const r = r0 + i * step;
    const y = y0 + i * rise;
    if (shape === 'circle') {
      // ярус — кольцо (ступенька) с подступёнком, середина арены открыта
      const top = mesh(new THREE.RingGeometry(r - step / 2, r + step / 2, 64), tierMat, [0, y, 0], false);
      top.rotation.x = -Math.PI / 2;
      const riser = mesh(new THREE.CylinderGeometry(r - step / 2, r - step / 2, rise, 64, 1, true), tierMat, [0, y - rise / 2, 0], false);
      top.userData.heavy = riser.userData.heavy = true;
      group.add(top, riser);
      const n = Math.floor(2 * Math.PI * r * density);
      for (let k = 0; k < n; k++) {
        const a = ((k + rnd() * 0.4) / n) * Math.PI * 2;
        pts.push([Math.cos(a) * (r + 0.1), y, Math.sin(a) * (r + 0.1)]);
      }
    } else {
      // ярус — рамка из четырёх ступеней от пола до высоты ряда
      const h = y - y0 + 0.02;
      for (const [w, d, x, z] of [[2 * (r + step / 2), step, 0, -r], [2 * (r + step / 2), step, 0, r],
        [step, 2 * (r - step / 2), -r, 0], [step, 2 * (r - step / 2), r, 0]]) {
        const box = mesh(new THREE.BoxGeometry(w, h, d), tierMat, [x, y0 + h / 2 - 0.02, z], false);
        box.userData.heavy = true;
        group.add(box);
      }
      const n = Math.floor(2 * r * density);
      for (const [sx, sz, along] of [[0, -1, 'x'], [0, 1, 'x'], [-1, 0, 'z'], [1, 0, 'z']]) {
        for (let k = 0; k <= n; k++) {
          const t = -r + (2 * r * k) / n + (rnd() - 0.5) * 0.2;
          pts.push(along === 'x' ? [t, y, sz * (r + 0.1)] : [sx * (r + 0.1), y, t]);
        }
      }
    }
  }
  const people = pts.filter(([x, , z]) => !(gapFront && z > gapFront && Math.abs(x) < gapFront));
  const shirts = [0x2a3550, 0x5a1f22, 0x1f4a33, 0x3b3b3b, 0x6b5a2a, 0x24324d, 0x4a2a55, 0x7a7a7a, 0x103040];
  const skins = [0xf1c9a5, 0xd9a57a, 0xa86f4a, 0x6b432a, 0xe8b894];
  const bodies = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.24, 0.72, 6), mat(0xffffff, { roughness: 0.9 }), people.length);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 7, 5), mat(0xffffff, { roughness: 0.8 }), people.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  people.forEach(([x, y, z], i) => {
    const s = 0.9 + rnd() * 0.25;
    m.makeScale(s, s, s).setPosition(x, y + 0.36 * s, z);
    bodies.setMatrixAt(i, m);
    m.makeScale(s, s, s).setPosition(x, y + 0.86 * s, z);
    heads.setMatrixAt(i, m);
    bodies.setColorAt(i, col.setHex(shirts[Math.floor(rnd() * shirts.length)]));
    heads.setColorAt(i, col.setHex(skins[Math.floor(rnd() * skins.length)]));
  });
  group.add(heavy(bodies), heavy(heads));
  return people;
}

/** Луч прожектора: полупрозрачный конус с аддитивным смешиванием. */
function beam(group, from, to, color, radius = 1.4, opacity = 0.07) {
  const dir = new THREE.Vector3().subVectors(from, to);
  const len = dir.length();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(radius, len, 24, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  cone.position.copy(from).add(to).multiplyScalar(0.5);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize().negate());
  group.add(heavy(cone));
  const lamp = mesh(new THREE.CylinderGeometry(0.25, 0.35, 0.5, 12), mat(0x111111, { metalness: 0.6 }), [from.x, from.y + 0.2, from.z], false);
  lamp.add(mesh(new THREE.CircleGeometry(0.24, 16), glow(0xffffff), [0, -0.26, 0], false));
  lamp.children[0].rotation.x = Math.PI / 2;
  group.add(lamp);
}

/** Вспышки фотокамер в толпе. */
function flashes(group, anim, people, seed) {
  const [c, g] = canvas(64, 64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.3, 'rgba(255,255,240,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const map = new THREE.CanvasTexture(c);
  const rnd = rng(seed);
  const sprites = [];
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.set(0.9, 0.9, 1);
    s.userData.t = -1;
    group.add(heavy(s));
    sprites.push(s);
  }
  anim.add((now) => {
    for (const s of sprites) {
      if (s.userData.t < 0 && rnd() < 0.004) {
        const p = people[Math.floor(rnd() * people.length)];
        s.position.set(p[0], p[1] + 1.1, p[2]);
        s.userData.t = now;
      }
      if (s.userData.t >= 0) {
        const t = (now - s.userData.t) / 1000;
        s.material.opacity = Math.max(0, 1 - t * 6);
        if (t > 0.2) s.userData.t = -1;
      }
    }
    return true;
  }, true);
}

function mug(group, x, z, color = 0xe39b1f) {
  group.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.04, 32), mat(0xd8c49a, { roughness: 0.9 }), [x, 0.02, z]));
  group.add(mesh(new THREE.CylinderGeometry(0.4, 0.37, 1.05, 32), mat(color, { roughness: 0.25, transparent: true, opacity: 0.88 }), [x, 0.57, z]));
  group.add(mesh(new THREE.CylinderGeometry(0.43, 0.41, 0.28, 32), mat(0xfff6e0, { roughness: 0.95 }), [x, 1.2, z]));
  group.add(mesh(new THREE.CylinderGeometry(0.47, 0.44, 1.32, 32, 1, true),
    mat(0xffffff, { transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide }), [x, 0.7, z], false));
  const handle = mesh(new THREE.TorusGeometry(0.3, 0.07, 10, 24, Math.PI), mat(0xffffff, { transparent: true, opacity: 0.35, roughness: 0.05 }),
    [x + 0.47, 0.72, z]);
  handle.rotation.z = -Math.PI / 2;
  group.add(handle);
}

function pendantLamp(group, x, y, z, shadeColor) {
  group.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 6, 4), mat(0x111111), [x, y + 3.2, z], false));
  const shade = mesh(new THREE.ConeGeometry(0.75, 0.6, 24, 1, true), mat(shadeColor, { side: THREE.DoubleSide, roughness: 0.4, metalness: 0.3 }), [x, y, z], false);
  group.add(shade);
  group.add(mesh(new THREE.SphereGeometry(0.22, 16, 8), glow(0xfff1c4), [x, y - 0.22, z], false));
}

// ---------- сукно ----------

function buildFelt(renderer, quality) {
  const [c, g] = canvas();
  // деревянная столешница
  const rnd = rng(3);
  g.fillStyle = '#5b3418';
  g.fillRect(0, 0, SIZE, SIZE);
  for (let k = 0; k < 160; k++) {
    g.strokeStyle = `rgba(${30 + rnd() * 30},${12 + rnd() * 10},4,${0.15 + rnd() * 0.25})`;
    g.lineWidth = 1 + rnd() * 3;
    g.beginPath();
    const y0 = rnd() * SIZE, ph = rnd() * 6;
    for (let x = 0; x <= SIZE; x += 16) g.lineTo(x, y0 + Math.sin(x * 0.006 + ph) * 8);
    g.stroke();
  }
  // сукно
  g.fillStyle = '#1f6b44';
  g.fillRect(u(-5), u(-3.5), 10 * PX, 7 * PX);
  const img = g.getImageData(u(-5), u(-3.5), 10 * PX, 7 * PX);
  const r2 = rng(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r2() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, u(-5), u(-3.5));
  g.strokeStyle = 'rgba(242,193,78,0.35)';
  g.lineWidth = 3;
  g.strokeRect(u(-4.7), u(-3.2), 9.4 * PX, 6.4 * PX);
  g.fillStyle = 'rgba(242,193,78,0.25)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic 800 54px Georgia, serif';
  g.fillText('1000', 512, u(-2.4));
  // круг света от лампы
  const light = g.createRadialGradient(512, 500, 60, 512, 512, 8 * PX);
  light.addColorStop(0, 'rgba(255,240,200,0.18)');
  light.addColorStop(0.55, 'rgba(0,0,0,0)');
  light.addColorStop(1, 'rgba(0,0,0,0.7)');
  g.fillStyle = light;
  g.fillRect(0, 0, SIZE, SIZE);

  const group = new THREE.Group();
  const wood = mat(0x4a2812, { roughness: 0.45 });
  // бортик вокруг сукна
  for (const [w, d, x, z] of [[11.2, 0.6, 0, -3.8], [11.2, 0.6, 0, 3.8], [0.6, 8.2, -5.3, 0], [0.6, 8.2, 5.3, 0]]) {
    group.add(mesh(new THREE.BoxGeometry(w, 0.35, d), wood, [x, 0.175, z]));
  }
  // край стола
  for (const [w, d, x, z] of [[15, 0.4, 0, 5.3], [15, 0.4, 0, -5.3], [0.4, 11, 7.3, 0], [0.4, 11, -7.3, 0]]) {
    group.add(mesh(new THREE.BoxGeometry(w, 3, d), mat(0x3a1f0d, { roughness: 0.5 }), [x, -1.5, z]));
  }
  mug(group, 6.2, -3.4, 0x4a2410); // кофе
  // блокнот со счётом и карандаш
  const pad = mesh(new THREE.BoxGeometry(1.8, 0.05, 2.4), [mat(0xeeeeee), mat(0xeeeeee),
    new THREE.MeshStandardMaterial({ map: label(renderer, 256, 340, (gg, w, h) => {
      gg.fillStyle = '#fbf7e8';
      gg.fillRect(0, 0, w, h);
      gg.strokeStyle = 'rgba(60,110,200,0.35)';
      for (let y = 40; y < h; y += 34) { gg.beginPath(); gg.moveTo(0, y); gg.lineTo(w, y); gg.stroke(); }
      gg.strokeStyle = 'rgba(220,60,60,0.5)';
      gg.beginPath(); gg.moveTo(40, 0); gg.lineTo(40, h); gg.stroke();
      gg.fillStyle = '#1d2a6b';
      gg.font = 'italic 28px "Comic Sans MS", cursive';
      ['Вася  450', 'Петя  320', 'Маша  95', 'Оля   555 🚛'].forEach((t, i) => gg.fillText(t, 52, 66 + i * 68));
    }), roughness: 0.9 }), mat(0xeeeeee), mat(0xeeeeee), mat(0xeeeeee)], [-6.1, 0.03, -1.6]);
  pad.rotation.y = 0.25;
  group.add(pad);
  const pencil = mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), mat(0xf2c14e), [-5.3, 0.06, 0.4]);
  pencil.rotation.set(0, 0.5, Math.PI / 2);
  group.add(pencil);
  const tip = mesh(new THREE.ConeGeometry(0.05, 0.18, 6), mat(0xd9b48a), [0, -0.89, 0], false);
  tip.rotation.z = Math.PI;
  pencil.add(tip);
  // лампа над столом
  pendantLamp(group, 0, 7.2, -4.8, 0x1f5a3a);
  return {
    floor: texture(c, renderer),
    floorShape: { w: 15, d: 11 },
    ground: 0x1a120c, groundY: -3,
    clear: 0x0d0805, fog: [0x0d0805, 34, 75],
    light: { sky: 0xfff4dc, ground: 0x2a1a0a, hemi: 1.05, sun: 0xfff1d6, sunI: 2.0 },
    view: { r: 6.6, z: -0.6 },
    group,
    wall: { type: 'box', hx: 4.45, hz: 2.95 },
    onWall(p) {
      // бортик чуть вздрагивает
      for (const o of group.children.slice(0, 4)) wobble(o, new THREE.Vector3(Math.sign(p.x) * 0.2, 0, Math.sign(p.z) * 0.2), 0.015);
    },
    update(now) { return updateWobbles(group, now); },
  };
}

// ---------- октагон MMA ----------

function buildOctagon(renderer, quality) {
  const A = 3.45; // апофема клетки
  const APRON = A + 1.0;
  const [c, g] = canvas();
  g.fillStyle = '#121318';
  g.fillRect(0, 0, SIZE, SIZE);
  poly(g, octagon(512, 512, A * PX));
  const mg = g.createRadialGradient(512, 500, 30, 512, 512, A * PX * 1.1);
  mg.addColorStop(0, '#3a4256');
  mg.addColorStop(0.7, '#262c3b');
  mg.addColorStop(1, '#1a1e29');
  g.fillStyle = mg;
  g.fill();
  grain(g, SIZE, SIZE, 14, 11);
  const corner = (k, col) => {
    const pts = octagon(512, 512, A * PX);
    const [vx, vy] = pts[k];
    const [ax, ay] = pts[(k + 7) % 8];
    const [bx, by] = pts[(k + 1) % 8];
    const f = 0.35;
    poly(g, [[vx, vy], [vx + (ax - vx) * f, vy + (ay - vy) * f], [512 + (vx - 512) * 0.78, 512 + (vy - 512) * 0.78],
      [vx + (bx - vx) * f, vy + (by - vy) * f]]);
    g.fillStyle = col;
    g.fill();
  };
  corner(5, 'rgba(214,40,40,0.85)');
  corner(1, 'rgba(36,99,235,0.85)');
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 4;
  poly(g, octagon(512, 512, (A - 0.25) * PX));
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(512, 512, 1.25 * PX, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2;
  g.beginPath();
  g.arc(512, 512, 1.05 * PX, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 64px system-ui, sans-serif';
  g.fillText('1000', 512, 500);
  g.font = '700 17px system-ui, sans-serif';
  g.fillText('DICE  FIGHT', 512, 548);
  g.font = '800 30px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.fillText('ROUND 1000', 512, 512 - (A - 0.6) * PX);

  const group = new THREE.Group();
  const anim = animator(quality);
  // платформа: юбка восьмиугольника
  const skirt = mesh(new THREE.CylinderGeometry(APRON / Math.cos(Math.PI / 8), APRON / Math.cos(Math.PI / 8), 1.1, 8, 1, true, Math.PI / 8),
    mat(0x0c0d12, { side: THREE.DoubleSide }), [0, -0.55, 0], false);
  group.add(skirt);
  // лесенка к клетке (слева)
  for (let i = 0; i < 3; i++) {
    group.add(mesh(new THREE.BoxGeometry(0.55, 0.37 * (3 - i), 1.6), mat(0x1c1d22), [-(APRON + 0.28 + i * 0.55), -1.1 + 0.185 * (3 - i), -1.2]));
  }
  // клетка
  const pts = octagon(0, 0, A);
  const side = 2 * A * Math.tan(Math.PI / 8);
  const H = 3.1;
  const postMat = mat(0x0d0d0f, { roughness: 0.45 });
  pts.forEach(([x, z]) => group.add(mesh(new THREE.CylinderGeometry(0.19, 0.19, H, 16), postMat, [x, H / 2, z])));
  const [lc, lg] = canvas(64, 64);
  lg.strokeStyle = '#b8bec6';
  lg.lineWidth = 4;
  lg.beginPath();
  lg.moveTo(0, 0); lg.lineTo(64, 64);
  lg.moveTo(64, 0); lg.lineTo(0, 64);
  lg.stroke();
  const fenceH = H - 0.55;
  const fenceMat = new THREE.MeshStandardMaterial({
    map: texture(lc, renderer, [side / 0.32, fenceH / 0.32]), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.35,
  });
  const padMat = mat(0x111114, { roughness: 0.5 });
  const railMat = mat(0x1a1a1d, { metalness: 0.6, roughness: 0.3 });
  const panels = [];
  for (let k = 0; k < 8; k++) {
    const phi = (k * Math.PI) / 4;
    const nx = Math.cos(phi), nz = Math.sin(phi);
    const rotY = Math.atan2(-nx, -nz);
    const fence = mesh(new THREE.PlaneGeometry(side, fenceH), fenceMat, [nx * A, 0.45 + fenceH / 2, nz * A], false);
    fence.rotation.y = rotY;
    const pad = mesh(new THREE.BoxGeometry(side, 0.45, 0.28), padMat, [nx * (A + 0.05), 0.225, nz * (A + 0.05)]);
    pad.rotation.y = rotY;
    const rail = mesh(new THREE.BoxGeometry(side, 0.14, 0.14), railMat, [nx * A, H - 0.05, nz * A]);
    rail.rotation.y = rotY;
    group.add(fence, pad, rail);
    const objs = [fence, rail];
    if (k === 4) { // дверца
      const door = new THREE.Group();
      door.position.set(nx * (A - 0.02), 0.45, nz * (A - 0.02));
      door.rotation.y = rotY;
      for (const [w, h, x, y] of [[0.08, fenceH, -0.6, fenceH / 2], [0.08, fenceH, 0.6, fenceH / 2], [1.28, 0.08, 0, fenceH], [1.28, 0.08, 0, fenceH / 2]]) {
        door.add(mesh(new THREE.BoxGeometry(w, h, 0.06), railMat, [x, y, 0], false));
      }
      door.add(mesh(new THREE.BoxGeometry(0.12, 0.2, 0.12), mat(0xb0b0b0, { metalness: 0.9, roughness: 0.2 }), [0.48, fenceH / 2, 0.06], false));
      group.add(door);
      objs.push(door);
    }
    panels.push({ phi, objs, normal: new THREE.Vector3(nx, 0, nz) });
  }
  // стол судей
  const judges = new THREE.Group();
  judges.position.set(0, -1.1, -(APRON + 1.4));
  judges.add(mesh(new THREE.BoxGeometry(3.6, 0.85, 0.8), mat(0x15161c), [0, 0.425, 0]));
  const screen = label(renderer, 128, 80, (gg, w, h) => {
    gg.fillStyle = '#05101e';
    gg.fillRect(0, 0, w, h);
    gg.fillStyle = '#4fd1ff';
    gg.font = '700 22px monospace';
    gg.fillText('10–9', 30, 48);
  });
  for (const x of [-1.1, 0, 1.1]) {
    const mon = mesh(new THREE.BoxGeometry(0.75, 0.48, 0.05), [mat(0x111111), mat(0x111111), mat(0x111111), mat(0x111111),
      glow(0xffffff, { map: screen }), mat(0x111111)], [x, 1.15, 0.05]);
    mon.rotation.x = -0.25;
    judges.add(mon);
  }
  group.add(judges);
  // зрители, прожекторы, вспышки
  const people = crowd(group, { r0: APRON + 2.6, rows: 5, y0: -1.1, seed: 5 });
  for (const [x, z] of [[-6, -6], [6, -6], [-6.5, 5], [6.5, 5]]) {
    beam(group, new THREE.Vector3(x, 10, z), new THREE.Vector3(x * 0.3, 3.2, z * 0.3), 0xdfe8ff, 1.1, 0.045);
  }
  flashes(group, anim, people, 9);
  anim.add((now) => updateWobbles(group, now));
  return {
    floor: texture(c, renderer),
    floorShape: { sides: 8, r: APRON / Math.cos(Math.PI / 8) },
    ground: 0x07080b, groundY: -1.1,
    clear: 0x040507, fog: [0x040507, 30, 70],
    light: { sky: 0xdfe8ff, ground: 0x10131c, hemi: 0.75, sun: 0xffffff, sunI: 2.3 },
    view: { r: 6.3, z: -0.4 },
    group,
    wall: { type: 'circle', r: A - 0.55 },
    onWall(p) {
      const a = Math.atan2(p.z, p.x);
      let best = panels[0], bd = 9;
      for (const pn of panels) {
        const d = Math.abs(Math.atan2(Math.sin(a - pn.phi), Math.cos(a - pn.phi)));
        if (d < bd) { bd = d; best = pn; }
      }
      best.objs.forEach((o) => wobble(o, best.normal, 0.09));
    },
    update: anim.run,
  };
}

// ---------- боксёрский ринг ----------

function buildRing(renderer, quality) {
  const H = 3.55;
  const APRON = H + 0.9;
  const [c, g] = canvas();
  g.fillStyle = '#163a6b';
  g.fillRect(0, 0, SIZE, SIZE);
  const cg = g.createRadialGradient(512, 500, 40, 512, 512, H * PX * 1.3);
  cg.addColorStop(0, '#eef1f5');
  cg.addColorStop(1, '#c4cad3');
  g.fillStyle = cg;
  g.fillRect(u(-H), u(-H), 2 * H * PX, 2 * H * PX);
  grain(g, SIZE, SIZE, 12, 21);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(22,58,107,0.85)';
  g.font = '900 120px system-ui, sans-serif';
  g.fillText('1000', 512, 505);
  g.font = '800 26px system-ui, sans-serif';
  g.fillStyle = 'rgba(200,30,40,0.85)';
  g.fillText('CHAMPIONSHIP', 512, 575);

  const group = new THREE.Group();
  const anim = animator(quality);
  // помост с надписями
  const skirtTex = label(renderer, 512, 64, (gg, w, h) => {
    gg.fillStyle = '#12305a';
    gg.fillRect(0, 0, w, h);
    gg.fillStyle = '#f2c14e';
    gg.font = '900 40px system-ui, sans-serif';
    gg.textAlign = 'center';
    gg.textBaseline = 'middle';
    gg.fillText('★ 1000 ★ CHAMPIONSHIP ★', w / 2, h / 2);
  });
  const skirtMat = new THREE.MeshStandardMaterial({ map: skirtTex, roughness: 0.7 });
  group.add(mesh(new THREE.BoxGeometry(2 * APRON, 1.28, 2 * APRON), [skirtMat, skirtMat, mat(0x12305a), mat(0x12305a), skirtMat, skirtMat],
    [0, -0.66, 0], false));
  // лесенка
  for (let i = 0; i < 3; i++) {
    group.add(mesh(new THREE.BoxGeometry(1.4, 0.42 * (3 - i), 0.5), mat(0x2b2f38), [-2, -1.3 + 0.21 * (3 - i), APRON + 0.25 + i * 0.5]));
  }
  const corners = [[-H, -H, 0xd62828], [H, -H, 0xf4f4f4], [H, H, 0x2463eb], [-H, H, 0xf4f4f4]];
  for (const [x, z, col] of corners) {
    group.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 12), mat(0xb8bcc4, { metalness: 0.8, roughness: 0.3 }), [x, 1.4, z]));
    group.add(mesh(new THREE.BoxGeometry(0.42, 2.2, 0.42), mat(col, { roughness: 0.45 }), [x, 1.35, z]));
  }
  // табуретки в углах бойцов (на полу у помоста)
  for (const [x, z, col] of [[-(APRON + 0.9), -(APRON - 0.6), 0xd62828], [APRON + 0.9, APRON - 0.6, 0x2463eb]]) {
    group.add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.12, 16), mat(col), [x, -0.55, z]));
    for (const [dx, dz] of [[0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25]]) {
      group.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6), mat(0x999999, { metalness: 0.8 }), [x + dx, -0.95, z + dz], false));
    }
    group.add(mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.4, 12), mat(0x2a7de1, { transparent: true, opacity: 0.8 }), [x + 0.6, -1.1, z])); // бутылка воды
  }
  const ropes = [];
  const ropeCols = [0x2463eb, 0xf4f4f4, 0xd62828];
  [0.75, 1.4, 2.05].forEach((y, i) => {
    const rm = mat(ropeCols[i], { roughness: 0.4 });
    for (const [nx, nz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const r = mesh(new THREE.CylinderGeometry(0.065, 0.065, 2 * H, 10), rm, [nx * H, y, nz * H]);
      if (nz) r.rotation.z = Math.PI / 2;
      else r.rotation.x = Math.PI / 2;
      group.add(r);
      ropes.push({ obj: r, normal: new THREE.Vector3(nx, 0, nz) });
    }
  });
  // куб-табло над рингом
  const cubeTex = label(renderer, 256, 160, (gg, w, h) => {
    gg.fillStyle = '#050a14';
    gg.fillRect(0, 0, w, h);
    gg.fillStyle = '#ffcc33';
    gg.font = '900 72px system-ui, sans-serif';
    gg.textAlign = 'center';
    gg.textBaseline = 'middle';
    gg.fillText('1000', w / 2, h / 2 - 8);
    gg.fillStyle = '#ff4a3d';
    gg.font = '700 22px system-ui, sans-serif';
    gg.fillText('ROUND ∞', w / 2, h - 22);
  });
  const cube = new THREE.Group();
  cube.position.set(0, 8.2, -1);
  const scr = glow(0xffffff, { map: cubeTex });
  cube.add(mesh(new THREE.BoxGeometry(2.6, 1.6, 2.6), [scr, scr, mat(0x111111), mat(0x111111), scr, scr], [0, 0, 0], false));
  cube.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 4, 4), mat(0x111111), [0, 2.8, 0], false));
  group.add(cube);
  anim.add((now) => {
    cube.rotation.y = now * 0.0002;
    return true;
  }, true);
  const people = crowd(group, { shape: 'square', r0: APRON + 2.4, rows: 5, y0: -1.3, seed: 8 });
  for (const [x, z, col] of [[-6, -6, 0xffe2c0], [6, -6, 0xc0dcff], [-6, 6, 0xc0dcff], [6, 6, 0xffe2c0]]) {
    beam(group, new THREE.Vector3(x, 10, z), new THREE.Vector3(x * 0.3, 3.2, z * 0.3), col, 1.1, 0.045);
  }
  flashes(group, anim, people, 4);
  anim.add((now) => updateWobbles(group, now));
  return {
    floor: texture(c, renderer),
    floorShape: { w: 2 * APRON, d: 2 * APRON },
    ground: 0x090b10, groundY: -1.3,
    clear: 0x05070b, fog: [0x05070b, 30, 70],
    light: { sky: 0xffffff, ground: 0x1a2030, hemi: 0.95, sun: 0xffffff, sunI: 2.1 },
    view: { r: 6.4, z: -0.3 },
    group,
    wall: { type: 'box', hx: H - 0.55, hz: H - 0.55 },
    onWall(p) {
      const n = Math.abs(p.x) > Math.abs(p.z) ? new THREE.Vector3(Math.sign(p.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(p.z));
      for (const r of ropes) if (r.normal.dot(n) > 0.9) wobble(r.obj, n, 0.12);
    },
    update: anim.run,
  };
}

// ---------- барная стойка ----------

function woodCanvas(g, w, h, base, seed, board = 1.15 * PX) {
  const rnd = rng(seed);
  for (let y = 0; y < h; y += board) {
    const tint = 0.85 + rnd() * 0.3;
    g.fillStyle = `rgb(${Math.round(base[0] * tint)},${Math.round(base[1] * tint)},${Math.round(base[2] * tint)})`;
    g.fillRect(0, y, w, board);
    for (let k = 0; k < 26; k++) {
      g.strokeStyle = `rgba(${40 + rnd() * 30},${18 + rnd() * 12},5,${0.18 + rnd() * 0.25})`;
      g.lineWidth = 1 + rnd() * 2.5;
      g.beginPath();
      const y0 = y + rnd() * board;
      const amp = 2 + rnd() * 5, freq = 0.004 + rnd() * 0.01, ph = rnd() * 6;
      for (let x = 0; x <= w; x += 16) g.lineTo(x, y0 + Math.sin(x * freq + ph) * amp);
      g.stroke();
    }
    g.fillStyle = 'rgba(20,8,2,0.75)';
    g.fillRect(0, y, w, 3);
  }
}

function buildBar(renderer, quality) {
  const [c, g] = canvas();
  woodCanvas(g, SIZE, SIZE, [112, 66, 33], 31);
  for (const [x, z, r] of [[-3.2, -2.2, 0.55], [2.4, 1.6, 0.5], [-1.2, 1.9, 0.45], [3.4, -0.6, 0.5], [-5.5, 0.8, 0.5]]) {
    g.strokeStyle = 'rgba(30,12,2,0.28)';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(u(x), u(z), r * PX, 0.3, Math.PI * 1.85);
    g.stroke();
  }
  const sh = g.createRadialGradient(512, 470, 20, 512, 512, 560);
  sh.addColorStop(0, 'rgba(255,220,150,0.2)');
  sh.addColorStop(1, 'rgba(0,0,0,0.4)');
  g.fillStyle = sh;
  g.fillRect(0, 0, SIZE, SIZE);

  const group = new THREE.Group();
  const anim = animator(quality);
  const FRONT = 3.1, BACK = -3.5, FLOOR = -3.2;
  // стойка: передняя панель, бортик, латунная подставка для ног
  group.add(mesh(new THREE.BoxGeometry(16, -FLOOR, 0.4), mat(0x3a1d0b, { roughness: 0.5 }), [0, FLOOR / 2, FRONT + 0.2]));
  const lip = mesh(new THREE.CylinderGeometry(0.22, 0.22, 16, 16), mat(0x5a2f12, { roughness: 0.3 }), [0, 0, FRONT + 0.15]);
  lip.rotation.z = Math.PI / 2;
  group.add(lip);
  const foot = mesh(new THREE.CylinderGeometry(0.07, 0.07, 16, 10), mat(0xc9a54a, { metalness: 0.9, roughness: 0.25 }), [0, FLOOR + 0.5, FRONT + 0.75]);
  foot.rotation.z = Math.PI / 2;
  group.add(foot);
  // барные стулья
  for (const x of [-6, -2, 2, 6]) {
    group.add(mesh(new THREE.CylinderGeometry(0.6, 0.55, 0.2, 20), mat(0x6b1a14, { roughness: 0.5 }), [x, -0.95, FRONT + 1.4]));
    group.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.2, 8), mat(0xaaaaaa, { metalness: 0.9, roughness: 0.25 }), [x, -2.1, FRONT + 1.4], false));
  }
  // задняя стена: кирпич, полки с бутылками, зеркало, неоновая вывеска
  const brick = label(renderer, 512, 512, (gg, w, h) => {
    gg.fillStyle = '#2a140c';
    gg.fillRect(0, 0, w, h);
    for (let y = 0, row = 0; y < h; y += 32, row++) {
      for (let x = (row % 2) * -32; x < w; x += 64) {
        gg.fillStyle = `rgb(${90 + Math.random() * 40},${38 + Math.random() * 15},${25 + Math.random() * 10})`;
        gg.fillRect(x + 2, y + 2, 60, 28);
      }
    }
  });
  brick.wrapS = brick.wrapT = THREE.RepeatWrapping;
  brick.repeat.set(4, 3);
  group.add(mesh(new THREE.PlaneGeometry(24, 13), new THREE.MeshStandardMaterial({ map: brick, roughness: 0.95 }), [0, 3.2, -7.2], false));
  group.add(mesh(new THREE.PlaneGeometry(13, 4.2), mat(0x8fa3b0, { metalness: 0.9, roughness: 0.08 }), [0, 2.2, -7.15], false));
  const r = rng(12);
  const bottleCols = [0x2f6b2a, 0x7a4a12, 0xc9d6dc, 0x5a1220, 0x1d3f6b, 0xb5852a];
  for (const y of [0.5, 1.8, 3.1]) {
    group.add(mesh(new THREE.BoxGeometry(13, 0.1, 0.8), mat(0x3a1d0b), [0, y, -6.75]));
    for (let x = -6.1; x < 6.2; x += 0.55 + r() * 0.15) {
      const col = bottleCols[Math.floor(r() * bottleCols.length)];
      const h = 0.65 + r() * 0.35;
      const bm = mat(col, { roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 });
      const b = mesh(new THREE.CylinderGeometry(0.17, 0.17, h, 12), bm, [x, y + 0.05 + h / 2, -6.7 + (r() - 0.5) * 0.25], false);
      b.add(mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.32, 8), bm, [0, h / 2 + 0.16, 0], false));
      group.add(b);
    }
  }
  const neonTex = label(renderer, 512, 160, (gg, w, h) => {
    gg.clearRect(0, 0, w, h);
    gg.textAlign = 'center';
    gg.textBaseline = 'middle';
    gg.font = 'italic 900 110px "Brush Script MT", cursive';
    gg.shadowColor = '#ff3fa4';
    gg.shadowBlur = 24;
    gg.strokeStyle = '#ffd6ee';
    gg.lineWidth = 5;
    gg.strokeText('1000 bar', w / 2, h / 2);
    gg.strokeText('1000 bar', w / 2, h / 2);
  });
  const neon = mesh(new THREE.PlaneGeometry(5.5, 1.7), glow(0xffffff, { map: neonTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    [0, 4.75, -7.05], false);
  group.add(neon);
  anim.add((now) => {
    neon.material.opacity = Math.sin(now * 0.05) > 0.97 ? 0.55 : 1; // лёгкое мерцание
    return true;
  }, true);
  // пивные краны
  const tower = new THREE.Group();
  tower.position.set(3.6, 0, BACK + 0.5);
  tower.add(mesh(new THREE.BoxGeometry(2.4, 1.1, 0.4), mat(0xb8bcc4, { metalness: 0.9, roughness: 0.2 }), [0, 0.55, 0]));
  [[-0.75, 0xd62828], [0, 0x111111], [0.75, 0xf2c14e]].forEach(([x, col]) => {
    const spout = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.45, 8), mat(0xdddddd, { metalness: 0.9, roughness: 0.2 }), [x, 0.85, 0.3]);
    spout.rotation.x = Math.PI / 2;
    tower.add(spout);
    tower.add(mesh(new THREE.BoxGeometry(0.16, 0.6, 0.16), mat(col, { roughness: 0.4 }), [x, 1.4, 0.15]));
  });
  group.add(tower);
  mug(group, -5.4, -2.6);
  // бокалы
  for (const [x, z] of [[5.9, -1.4], [6.4, -2.4]]) {
    group.add(mesh(new THREE.CylinderGeometry(0.32, 0.25, 0.95, 20, 1, true),
      mat(0xffffff, { transparent: true, opacity: 0.25, roughness: 0.05, side: THREE.DoubleSide }), [x, 0.48, z], false));
    group.add(mesh(new THREE.CylinderGeometry(0.29, 0.24, 0.6, 20), mat(0xe8a020, { transparent: true, opacity: 0.8, roughness: 0.2 }), [x, 0.31, z], false));
  }
  // миска с орешками
  const bx = -6.2, bz = -0.4;
  group.add(mesh(new THREE.SphereGeometry(0.6, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(0x8c2f1b, { side: THREE.DoubleSide, roughness: 0.4 }),
    [bx, 0.6, bz]));
  const nutMat = mat(0xc89048, { roughness: 0.8 });
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2, d = r() * 0.38;
    group.add(mesh(new THREE.SphereGeometry(0.11, 8, 6), nutMat, [bx + Math.cos(a) * d, 0.5 + r() * 0.08, bz + Math.sin(a) * d], false));
  }
  for (const x of [-4.2, 0, 4.2]) pendantLamp(group, x, 4.6, -2.6, 0x8a4a12);
  return {
    floor: texture(c, renderer),
    floorShape: { w: 16, d: FRONT - BACK, cz: (FRONT + BACK) / 2 },
    ground: 0x1a0d06, groundY: FLOOR,
    clear: 0x0d0603, fog: [0x0d0603, 32, 75],
    light: { sky: 0xffe2b0, ground: 0x2a1406, hemi: 1.0, sun: 0xffd9a0, sunI: 2.0 },
    view: { r: 7.2, z: -1.4, el: 42 },
    group,
    wall: null,
    update: anim.run,
  };
}

// ---------- казино (крэпс) ----------

function buildCasino(renderer, quality) {
  const [c, g] = canvas();
  g.fillStyle = '#7a1119';
  g.fillRect(0, 0, SIZE, SIZE);
  grain(g, SIZE, SIZE, 16, 41);
  g.strokeStyle = 'rgba(255,240,200,0.85)';
  g.fillStyle = 'rgba(255,240,200,0.88)';
  g.lineWidth = 5;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.beginPath();
  g.ellipse(512, u(-1.5), 5.4 * PX, 3.5 * PX, 0, 0.12 * Math.PI, 0.88 * Math.PI);
  g.stroke();
  g.beginPath();
  g.ellipse(512, u(-1.5), 4.6 * PX, 2.9 * PX, 0, 0.1 * Math.PI, 0.9 * Math.PI);
  g.stroke();
  g.font = '800 40px Georgia, serif';
  g.fillText('PASS LINE', 512, u(1.75));
  g.strokeRect(u(-3.6), u(-2.7), 7.2 * PX, 1.25 * PX);
  g.font = '700 30px Georgia, serif';
  g.fillText('2 · 3 · 4 · 9 · 10 · 11 · 12', 512, u(-2.25));
  g.font = '800 22px Georgia, serif';
  g.fillStyle = '#f2c14e';
  g.fillText('FIELD', 512, u(-1.7));
  g.font = '900 72px Georgia, serif';
  g.fillStyle = 'rgba(255,240,200,0.5)';
  g.fillText('COME', u(-1.9), u(-0.35));
  g.font = '700 26px Georgia, serif';
  g.fillText("DON'T PASS BAR", u(2.2), u(0.45));
  for (const x of [-4.6, 4.6]) { // боковые зоны ставок
    g.strokeRect(u(x) - 0.6 * PX, u(-2.9), 1.2 * PX, 5.2 * PX);
  }

  const group = new THREE.Group();
  const anim = animator(quality);
  const W = 12, D = 7.6, CZ = -0.5, FLOOR = -2.6;
  // задний бортик с резиновыми пирамидками
  const [pc, pg] = canvas(64, 64);
  pg.fillStyle = '#1b1b1b';
  pg.fillRect(0, 0, 64, 64);
  const tri = (pts, col) => { poly(pg, pts); pg.fillStyle = col; pg.fill(); };
  tri([[0, 0], [64, 0], [32, 32]], '#3a3a3a');
  tri([[64, 0], [64, 64], [32, 32]], '#2a2a2a');
  tri([[0, 64], [64, 64], [32, 32]], '#111');
  tri([[0, 0], [0, 64], [32, 32]], '#222');
  const wallZ = -3.35;
  const wall = mesh(new THREE.BoxGeometry(W - 0.4, 1.0, 0.35), [
    mat(0x111111), mat(0x111111), mat(0x3b2412), mat(0x111111),
    new THREE.MeshStandardMaterial({ map: texture(pc, renderer, [(W - 0.4) / 0.3, 1 / 0.3]), roughness: 0.8 }), mat(0x111111),
  ], [0, 0.5, wallZ]);
  group.add(wall);
  // мягкий бортик стола и корпус
  const leather = mat(0x2a120a, { roughness: 0.35 });
  const z0 = CZ - D / 2, z1 = CZ + D / 2;
  for (const [w, d, x, z] of [[W + 1.4, 0.7, 0, z0 - 0.35], [W + 1.4, 0.7, 0, z1 + 0.35], [0.7, D, -W / 2 - 0.35, CZ], [0.7, D, W / 2 + 0.35, CZ]]) {
    const rail = mesh(new THREE.BoxGeometry(w, 0.55, d), leather, [x, 0.27, z]);
    group.add(rail);
  }
  group.add(mesh(new THREE.BoxGeometry(W + 1.4, -FLOOR - 0.05, D + 1.4), mat(0x2b1408, { roughness: 0.6 }), [0, FLOOR / 2 - 0.03, CZ], false));
  // палочка крупье
  const stick = mesh(new THREE.CylinderGeometry(0.04, 0.04, 4.6, 8), mat(0xc9a066, { roughness: 0.5 }), [-2.6, 0.05, -2.75]);
  stick.rotation.z = Math.PI / 2;
  group.add(stick);
  group.add(mesh(new THREE.BoxGeometry(0.1, 0.06, 0.45), mat(0xc9a066), [-0.3, 0.05, -2.58]));
  // стопки фишек на бортике
  const chipCols = [0xd62828, 0x1f8a4c, 0x111111, 0xf4f4f4, 0x2463eb];
  const stacks = [[-6.35, -2.6, 7, 0], [-6.35, -1.4, 4, 1], [6.35, -2.1, 9, 2], [6.35, -0.9, 5, 3], [-6.35, 0.4, 3, 4], [6.35, 1.2, 6, 0]];
  for (const [x, z, n, ci] of stacks) {
    for (let i = 0; i < n; i++) {
      const col = chipCols[(ci + (i % 3 === 2 ? 1 : 0)) % chipCols.length];
      group.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.07, 24), mat(col, { roughness: 0.4 }), [x, 0.59 + i * 0.075, z]));
    }
  }
  // игровые автоматы
  const slotTex = label(renderer, 128, 96, (gg, w, h) => {
    gg.fillStyle = '#05050a';
    gg.fillRect(0, 0, w, h);
    gg.fillStyle = '#ffe14d';
    gg.font = '900 44px system-ui, sans-serif';
    gg.textAlign = 'center';
    gg.textBaseline = 'middle';
    gg.fillText('7 7 7', w / 2, h / 2);
  });
  const lights = [];
  for (let i = 0; i < 7; i++) {
    const x = -9 + i * 3;
    const m = new THREE.Group();
    m.position.set(x, FLOOR, -9.5);
    m.add(mesh(new THREE.BoxGeometry(1.7, 3.4, 1.2), mat(i % 2 ? 0x7a1119 : 0x1d2f6b, { roughness: 0.4, metalness: 0.3 }), [0, 1.7, 0]));
    const scr = mesh(new THREE.PlaneGeometry(1.2, 0.9), glow(0xffffff, { map: slotTex }), [0, 2.3, 0.61], false);
    m.add(scr);
    const top = mesh(new THREE.SphereGeometry(0.28, 12, 8), glow(0xff3030), [0, 3.65, 0], false);
    m.add(top);
    lights.push(top);
    group.add(m);
  }
  const lightCols = [0xff3030, 0xffd23a, 0x3aff7a, 0x3ac8ff];
  anim.add((now) => {
    lights.forEach((l, i) => l.material.color.setHex(lightCols[(Math.floor(now / 350) + i) % lightCols.length]));
    return true;
  }, true);
  // ковёр казино
  const carpet = label(renderer, 256, 256, (gg, w, h) => {
    gg.fillStyle = '#3a0d14';
    gg.fillRect(0, 0, w, h);
    gg.strokeStyle = '#c9a54a';
    gg.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      gg.beginPath();
      gg.arc(64 + (i % 2) * 128, 64 + Math.floor(i / 2) * 128, 40, 0, Math.PI * 2);
      gg.stroke();
    }
    gg.fillStyle = '#1d3f6b';
    gg.beginPath();
    gg.arc(128, 128, 18, 0, Math.PI * 2);
    gg.fill();
  });
  carpet.wrapS = carpet.wrapT = THREE.RepeatWrapping;
  carpet.repeat.set(55, 55);
  anim.add((now) => updateWobbles(group, now));
  return {
    floor: texture(c, renderer),
    floorShape: { w: W, d: D, cz: CZ },
    ground: 0x2a0a10, groundY: FLOOR, groundTex: carpet,
    clear: 0x0d0405, fog: [0x0d0405, 32, 75],
    light: { sky: 0xfff3dc, ground: 0x2a0a0d, hemi: 1.05, sun: 0xffffff, sunI: 1.9 },
    view: { r: 7.4, z: -1.2, el: 45 },
    group,
    wall: { type: 'back', z: wallZ + 0.7 },
    onWall() { wobble(wall, new THREE.Vector3(0, 0, -1), 0.03); },
    update: anim.run,
  };
}

// ---------- космос ----------

function buildSpace(renderer, quality) {
  const R = 3.9;
  const [c, g] = canvas(512, 512);
  const bg = g.createRadialGradient(256, 256, 20, 256, 256, 256);
  bg.addColorStop(0, '#1b2a6b');
  bg.addColorStop(1, '#070a1f');
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(90,220,255,0.28)';
  g.lineWidth = 1.5;
  for (let i = 0; i <= 512; i += 512 / 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
  }
  g.strokeStyle = 'rgba(120,240,255,0.7)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(256, 256, 70, 0, Math.PI * 2);
  g.stroke();

  const group = new THREE.Group();
  const anim = animator(quality);
  const platTop = new THREE.MeshStandardMaterial({ map: texture(c, renderer), roughness: 0.25, metalness: 0.3 });
  const platSide = mat(0x0e1440, { metalness: 0.6, roughness: 0.3 });
  group.add(mesh(new THREE.CylinderGeometry(R, R * 0.92, 0.3, 64), [platSide, platTop, platSide], [0, -0.15, 0], false));
  // нижняя часть станции
  group.add(mesh(new THREE.CylinderGeometry(R * 0.9, 1.2, 2.2, 32), mat(0x161c48, { metalness: 0.7, roughness: 0.35 }), [0, -1.4, 0], false));
  group.add(mesh(new THREE.SphereGeometry(0.6, 16, 8), glow(0x5ff2ff), [0, -2.6, 0], false));
  const rim = mesh(new THREE.TorusGeometry(R, 0.06, 10, 96), glow(0x5ff2ff), [0, 0.0, 0], false);
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
  // огни по краю платформы — бегущая волна
  const bulbs = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const b = mesh(new THREE.SphereGeometry(0.07, 8, 6), glow(0x5ff2ff), [Math.cos(a) * (R + 0.18), 0.02, Math.sin(a) * (R + 0.18)], false);
    group.add(b);
    bulbs.push(b);
  }
  anim.add((now) => {
    bulbs.forEach((b, i) => b.material.color.setHex(((Math.floor(now / 80) - i) % 32 + 32) % 32 < 4 ? 0xffffff : 0x2a8fa8));
    return true;
  }, true);
  // туманность на небесной сфере
  const neb = label(renderer, 1024, 512, (gg, w, h) => {
    gg.fillStyle = '#02030b';
    gg.fillRect(0, 0, w, h);
    const r = rng(19);
    for (let i = 0; i < 40; i++) {
      const x = r() * w, y = h * (0.25 + r() * 0.5), rr = 60 + r() * 170;
      const cols = ['120,60,200', '40,90,220', '200,50,140', '30,160,200'];
      const gr = gg.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, `rgba(${cols[i % 4]},0.18)`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      gg.fillStyle = gr;
      gg.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    for (let i = 0; i < 900; i++) {
      gg.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.7})`;
      gg.fillRect(r() * w, r() * h, 1.2, 1.2);
    }
  });
  group.add(mesh(new THREE.SphereGeometry(110, 32, 16), new THREE.MeshBasicMaterial({ map: neb, side: THREE.BackSide, fog: false }), [0, 0, 0], false));
  // звёзды
  const n = 1800;
  const pos = new Float32Array(n * 3);
  const r = rng(77);
  for (let i = 0; i < n; i++) {
    const th = r() * Math.PI * 2, ph = Math.acos(r() * 2 - 1), d = 30 + r() * 30;
    pos.set([d * Math.sin(ph) * Math.cos(th), d * Math.cos(ph) - 6, d * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  group.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, sizeAttenuation: true, fog: false })));
  // планета с кольцом и луна
  const [plc, plg] = canvas(256, 128);
  const pgr = plg.createLinearGradient(0, 0, 0, 128);
  ['#f2b880', '#c97a4a', '#f5d0a0', '#a85a35', '#e9b07a', '#c46a40'].forEach((col, i, a) => pgr.addColorStop(i / (a.length - 1), col));
  plg.fillStyle = pgr;
  plg.fillRect(0, 0, 256, 128);
  const planet = mesh(new THREE.SphereGeometry(4.2, 48, 24), new THREE.MeshStandardMaterial({ map: texture(plc, renderer), roughness: 0.9 }),
    [11, -2, -14], false);
  const ring = mesh(new THREE.RingGeometry(5.4, 7.6, 64), glow(0xe8c9a0, { transparent: true, opacity: 0.55, side: THREE.DoubleSide }), [11, -2, -14], false);
  ring.rotation.set(-1.2, 0.3, 0);
  group.add(planet, ring);
  group.add(mesh(new THREE.SphereGeometry(1.2, 24, 12), mat(0xb9c2d8, { roughness: 1 }), [-10, 1.5, -10], false));
  // астероиды на орбите
  const rocks = [];
  for (let i = 0; i < 12; i++) {
    const s = 0.25 + r() * 0.6;
    const rock = heavy(mesh(new THREE.IcosahedronGeometry(s, 0), mat(0x6b625a, { roughness: 1, flatShading: true }), [0, 0, 0], false));
    rock.userData.orbit = { rad: 8 + r() * 5, a: r() * Math.PI * 2, y: -2 + r() * 5, sp: 0.00004 + r() * 0.00008 };
    group.add(rock);
    rocks.push(rock);
  }
  anim.add((now) => {
    for (const k of rocks) {
      const o = k.userData.orbit;
      const a = o.a + now * o.sp;
      k.position.set(Math.cos(a) * o.rad, o.y, Math.sin(a) * o.rad);
      k.rotation.set(now * 0.0004, now * 0.0003, 0);
    }
    return true;
  }, true);
  // падающие звёзды
  const streak = heavy(mesh(new THREE.PlaneGeometry(3, 0.05), glow(0xffffff, { transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    [0, 0, 0], false));
  group.add(streak);
  let st = { t0: -1 };
  anim.add((now) => {
    if (st.t0 < 0 && Math.random() < 0.004) {
      st = { t0: now, x: -14 + Math.random() * 10, y: 6 + Math.random() * 5, z: -16 - Math.random() * 8 };
    }
    if (st.t0 >= 0) {
      const t = (now - st.t0) / 900;
      streak.position.set(st.x + t * 16, st.y - t * 5, st.z);
      streak.rotation.z = -0.3;
      streak.material.opacity = Math.sin(Math.min(1, t) * Math.PI);
      if (t > 1) st.t0 = -1;
    }
    return true;
  }, true);
  return {
    floor: null,
    ground: null,
    clear: 0x02030b, fog: null,
    light: { sky: 0xbfd4ff, ground: 0x0a0a30, hemi: 0.95, sun: 0xffffff, sunI: 2.1 },
    view: { r: 5.8, z: -0.4 },
    group,
    wall: null,
    update: anim.run,
  };
}

// ---------- пляж ----------

function buildBeach(renderer, quality) {
  const [c, g] = canvas();
  g.fillStyle = '#e6cf98';
  g.fillRect(0, 0, SIZE, SIZE);
  grain(g, SIZE, SIZE, 26, 51);
  const r = rng(9);
  g.strokeStyle = 'rgba(160,120,60,0.18)';
  g.lineWidth = 3;
  for (let k = 0; k < 40; k++) {
    const y0 = r() * SIZE;
    g.beginPath();
    for (let x = 0; x <= SIZE; x += 16) g.lineTo(x, y0 + Math.sin(x * 0.02 + k) * 6);
    g.stroke();
  }
  // мокрый песок у воды
  const wet = g.createLinearGradient(0, u(-4.2), 0, u(-2.4));
  wet.addColorStop(0, 'rgba(120,85,40,0.55)');
  wet.addColorStop(1, 'rgba(120,85,40,0)');
  g.fillStyle = wet;
  g.fillRect(0, 0, SIZE, u(-2.4));
  // тень пальмы
  g.save();
  g.translate(u(-4.8), u(-3.2));
  g.fillStyle = 'rgba(70,50,20,0.22)';
  for (let i = 0; i < 7; i++) {
    g.rotate((Math.PI * 2) / 7);
    g.beginPath();
    g.ellipse(70, 0, 80, 16, 0.3, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  // ракушки и морская звезда
  const star = (x, y, rr, rot) => {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = rot + (i * Math.PI) / 5, d = i % 2 ? rr * 0.42 : rr;
      g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }
    g.closePath();
    g.fillStyle = '#e8743b';
    g.fill();
  };
  star(u(3.7), u(1.9), 36, 0.4);
  const shell = (x, y, s, rot) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.beginPath();
    g.moveTo(0, s * 0.5);
    g.arc(0, 0, s, Math.PI * 1.05, Math.PI * 1.95);
    g.closePath();
    g.fillStyle = '#f7e1d0';
    g.fill();
    g.strokeStyle = 'rgba(190,120,100,0.8)';
    g.lineWidth = 2;
    for (let i = 1; i < 6; i++) {
      g.beginPath();
      g.moveTo(0, s * 0.5);
      const a = Math.PI * (1.05 + (0.9 * i) / 6);
      g.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      g.stroke();
    }
    g.restore();
  };
  shell(u(-3.8), u(-1.6), 26, 0.3);
  shell(u(-3.3), u(2.2), 20, -0.6);
  shell(u(3.4), u(-2.0), 18, 1.1);

  const group = new THREE.Group();
  const anim = animator(quality);
  // море: сетка с волнами
  const SEA_Z = -3.6;
  const seaGeo = new THREE.PlaneGeometry(90, 50, 90, 40);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = mesh(seaGeo, mat(0x1597b5, { roughness: 0.15, metalness: 0.15, transparent: true, opacity: 0.9 }), [0, 0.22, SEA_Z - 25], false);
  group.add(sea);
  const base = seaGeo.attributes.position.array.slice();
  const foam = mesh(new THREE.PlaneGeometry(90, 0.7), mat(0xffffff, { transparent: true, opacity: 0.85, roughness: 0.9 }), [0, 0.4, SEA_Z], false);
  foam.rotation.x = -Math.PI / 2;
  group.add(foam);
  anim.add((now) => {
    const t = now / 1000;
    const a = seaGeo.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const x = base[i], z = base[i + 2];
      a[i + 1] = Math.sin(x * 0.35 + t * 1.1) * 0.06 + Math.sin(z * 0.6 + t * 1.6) * 0.09;
    }
    seaGeo.attributes.position.needsUpdate = true;
    seaGeo.computeVertexNormals();
    const wash = Math.sin(t * 0.6);
    foam.position.z = SEA_Z + 0.35 + wash * 0.45;
    sea.position.z = SEA_Z - 25 + 0.3 + wash * 0.45;
    foam.material.opacity = 0.5 + 0.35 * (wash + 1) / 2;
    return true;
  }, true);
  // зонт
  const stripes = label(renderer, 512, 64, (gg, w, h) => {
    for (let i = 0; i < 12; i++) {
      gg.fillStyle = i % 2 ? '#ffffff' : '#e23b3b';
      gg.fillRect((i * w) / 12, 0, w / 12, h);
    }
  });
  const umb = new THREE.Group();
  umb.position.set(-5.4, 0, -2.0);
  umb.rotation.z = 0.12;
  umb.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.1, 8), mat(0xeeeeee, { metalness: 0.6 }), [0, 1.55, 0]));
  umb.add(mesh(new THREE.ConeGeometry(2.1, 0.75, 12, 1, true), new THREE.MeshStandardMaterial({ map: stripes, side: THREE.DoubleSide, roughness: 0.7 }),
    [0, 3.0, 0]));
  group.add(umb);
  // полотенце
  const towelTex = label(renderer, 128, 256, (gg, w, h) => {
    for (let i = 0; i < 8; i++) {
      gg.fillStyle = ['#2a7de1', '#ffffff', '#f2c14e', '#ffffff'][i % 4];
      gg.fillRect(0, (i * h) / 8, w, h / 8);
    }
  });
  const towel = mesh(new THREE.BoxGeometry(1.6, 0.03, 3.0), [mat(0x2a7de1), mat(0x2a7de1), new THREE.MeshStandardMaterial({ map: towelTex, roughness: 1 }),
    mat(0x2a7de1), mat(0x2a7de1), mat(0x2a7de1)], [-5.2, 0.015, 1.1]);
  towel.rotation.y = -0.2;
  group.add(towel);
  // пляжный мяч
  const ballTex = label(renderer, 256, 128, (gg, w, h) => {
    ['#e23b3b', '#ffffff', '#2a7de1', '#ffffff', '#f2c14e', '#ffffff'].forEach((col, i) => {
      gg.fillStyle = col;
      gg.fillRect((i * w) / 6, 0, w / 6, h);
    });
  });
  const ball = mesh(new THREE.SphereGeometry(0.45, 24, 16), new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.35 }), [5.3, 0.45, 1.6]);
  group.add(ball);
  // коктейль
  const cx = 5.7, cz = -2.1;
  group.add(mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.75, 20, 1, true), mat(0xffffff, { transparent: true, opacity: 0.3, side: THREE.DoubleSide, roughness: 0.05 }),
    [cx, 0.38, cz], false));
  group.add(mesh(new THREE.CylinderGeometry(0.24, 0.19, 0.55, 20), mat(0xff8a2a, { transparent: true, opacity: 0.85 }), [cx, 0.29, cz], false));
  const straw = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 6), mat(0x3ad0a0), [cx + 0.1, 0.75, cz], false);
  straw.rotation.z = -0.3;
  group.add(straw);
  group.add(mesh(new THREE.ConeGeometry(0.28, 0.14, 8), mat(0xff3fa4, { side: THREE.DoubleSide }), [cx - 0.12, 0.98, cz], false));
  // пальма
  const palm = new THREE.Group();
  palm.position.set(-7.6, 0, -4.4);
  let px = 0, py = 0;
  for (let i = 0; i < 8; i++) {
    const seg = mesh(new THREE.CylinderGeometry(0.22 - i * 0.012, 0.26 - i * 0.012, 0.7, 10), mat(0x7a5a32, { roughness: 0.95 }), [px, py + 0.35, 0]);
    seg.rotation.z = -0.06 * i;
    palm.add(seg);
    px += Math.sin(0.06 * i) * 0.7;
    py += 0.68;
  }
  const leafTex = label(renderer, 256, 64, (gg, w, h) => {
    gg.fillStyle = '#2f7a2a';
    gg.beginPath();
    gg.moveTo(0, h / 2);
    gg.quadraticCurveTo(w / 2, -h / 3, w, h / 2);
    gg.quadraticCurveTo(w / 2, h * 1.3, 0, h / 2);
    gg.fill();
    gg.strokeStyle = '#1d5a1a';
    gg.lineWidth = 3;
    gg.beginPath(); gg.moveTo(0, h / 2); gg.lineTo(w, h / 2); gg.stroke();
  });
  for (let i = 0; i < 8; i++) {
    const leaf = mesh(new THREE.PlaneGeometry(2.6, 0.7), new THREE.MeshStandardMaterial({ map: leafTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }),
      [px, py, 0]);
    leaf.geometry.translate(1.3, 0, 0);
    leaf.rotation.set(0, (i / 8) * Math.PI * 2, -0.45);
    palm.add(leaf);
  }
  group.add(palm);
  // чайки
  const gulls = [];
  for (let i = 0; i < 3; i++) {
    const gl = new THREE.Group();
    for (const s of [-1, 1]) {
      const w = mesh(new THREE.PlaneGeometry(0.5, 0.1), mat(0xffffff, { side: THREE.DoubleSide }), [s * 0.25, 0, 0], false);
      w.geometry.translate(s * 0.0, 0, 0);
      gl.add(w);
    }
    gl.userData.p = { r: 7 + i * 2, a: i * 2, y: 4 + i, sp: 0.00012 + i * 0.00003 };
    group.add(heavy(gl));
    gulls.push(gl);
  }
  anim.add((now) => {
    for (const gl of gulls) {
      const p = gl.userData.p;
      const a = p.a + now * p.sp;
      gl.position.set(Math.cos(a) * p.r, p.y, -9 + Math.sin(a) * 3);
      gl.rotation.y = -a;
      const flap = Math.sin(now * 0.012 + p.a) * 0.5;
      gl.children[0].rotation.z = flap;
      gl.children[1].rotation.z = -flap;
    }
    return true;
  }, true);
  return {
    floor: texture(c, renderer),
    floorShape: { w: 16, d: 16 },
    ground: 0xe3cc95, groundY: -0.03,
    clear: 0x9fd8f0, fog: [0xbfe6f5, 32, 90],
    light: { sky: 0xfff6dc, ground: 0x8a7550, hemi: 1.15, sun: 0xfff1d0, sunI: 2.3 },
    view: { r: 7.0, z: -1.0, el: 44 },
    group,
    wall: null,
    update: anim.run,
  };
}

// ---------- снег ----------

function buildSnow(renderer, quality) {
  const [c, g] = canvas();
  g.fillStyle = '#eaf2fb';
  g.fillRect(0, 0, SIZE, SIZE);
  grain(g, SIZE, SIZE, 10, 61);
  const r = rng(13);
  for (let i = 0; i < 26; i++) {
    const x = r() * SIZE, y = r() * SIZE, rr = 40 + r() * 120;
    const d = g.createRadialGradient(x, y, 0, x, y, rr);
    d.addColorStop(0, 'rgba(255,255,255,0.7)');
    d.addColorStop(1, 'rgba(180,205,235,0)');
    g.fillStyle = d;
    g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // следы на снегу
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const x = u(-7 + t * 3.2), y = u(3.6 - t * 1.8) + (i % 2 ? 10 : -10);
    g.fillStyle = 'rgba(140,170,210,0.45)';
    g.beginPath();
    g.ellipse(x, y, 9, 15, -0.9, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.95)' : 'rgba(150,190,255,0.7)';
    g.fillRect(r() * SIZE, r() * SIZE, 1.5, 1.5);
  }

  const group = new THREE.Group();
  const anim = animator(quality);
  const tree = (x, z, s) => {
    group.add(mesh(new THREE.CylinderGeometry(0.1 * s, 0.12 * s, 0.4 * s, 8), mat(0x5b3a1e), [x, 0.2 * s, z]));
    [[0.9, 0.9, 0.55], [0.7, 0.8, 1.05], [0.48, 0.7, 1.5]].forEach(([rad, h, y]) => {
      group.add(mesh(new THREE.ConeGeometry(rad * s, h * s, 10), mat(0x1f5a3a, { roughness: 0.9 }), [x, y * s, z]));
      group.add(mesh(new THREE.ConeGeometry(rad * s * 0.7, h * s * 0.35, 10), mat(0xffffff, { roughness: 1 }), [x, (y + h * 0.33) * s, z], false));
    });
  };
  for (const [x, z, s] of [[-6.4, -4.4, 1.9], [6.6, -4.2, 1.7], [-7.8, -0.6, 1.3], [7.9, 0.4, 1.4], [-3.2, -6.4, 1.6], [3.4, -6.8, 2.0], [0, -8.5, 2.3],
    [-9, -6, 2.2], [9.4, -5.6, 2.1]]) tree(x, z, s);
  // снеговик
  const sm = new THREE.Group();
  sm.position.set(5.2, 0, -2.0);
  const snowMat = mat(0xffffff, { roughness: 0.95 });
  sm.add(mesh(new THREE.SphereGeometry(0.75, 24, 16), snowMat, [0, 0.68, 0]));
  sm.add(mesh(new THREE.SphereGeometry(0.52, 24, 16), snowMat, [0, 1.72, 0]));
  sm.add(mesh(new THREE.SphereGeometry(0.36, 24, 16), snowMat, [0, 2.45, 0]));
  const carrot = mesh(new THREE.ConeGeometry(0.07, 0.45, 8), mat(0xff7a1a), [0, 2.45, 0.55]);
  carrot.rotation.x = Math.PI / 2;
  sm.add(carrot);
  for (const [x, y, z] of [[-0.12, 2.56, 0.31], [0.12, 2.56, 0.31], [0, 1.85, 0.5], [0, 1.62, 0.52], [0, 1.4, 0.48]]) {
    sm.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), mat(0x111111), [x, y, z], false));
  }
  sm.add(mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.4, 16), mat(0x111111), [0, 2.95, 0]));
  sm.add(mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.04, 16), mat(0x111111), [0, 2.76, 0]));
  const scarf = mesh(new THREE.TorusGeometry(0.36, 0.08, 8, 20), mat(0xd62828), [0, 2.12, 0]);
  scarf.rotation.x = Math.PI / 2;
  sm.add(scarf);
  for (const s of [-1, 1]) {
    const arm = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5), mat(0x5b3a1e), [s * 0.85, 1.9, 0]);
    arm.rotation.z = s * 1.0;
    sm.add(arm);
  }
  sm.rotation.y = -0.4;
  group.add(sm);
  // санки
  const sled = new THREE.Group();
  sled.position.set(-5.4, 0, 1.4);
  sled.rotation.y = 0.5;
  for (const x of [-0.45, 0, 0.45]) sled.add(mesh(new THREE.BoxGeometry(0.32, 0.06, 2.0), mat(0xb5602a, { roughness: 0.6 }), [x, 0.42, 0]));
  for (const x of [-0.55, 0.55]) {
    sled.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 2.1), mat(0xd62828, { metalness: 0.5 }), [x, 0.05, 0]));
    const curl = mesh(new THREE.TorusGeometry(0.22, 0.03, 6, 12, Math.PI), mat(0xd62828, { metalness: 0.5 }), [x, 0.27, 1.05]);
    curl.rotation.y = Math.PI / 2;
    sled.add(curl);
    for (const z of [-0.7, 0, 0.7]) sled.add(mesh(new THREE.BoxGeometry(0.05, 0.38, 0.05), mat(0xd62828), [x, 0.24, z], false));
  }
  group.add(sled);
  // гирлянда между ёлками
  const bulbs = [];
  const bulbCols = [0xff3b3b, 0xffd23a, 0x3aff7a, 0x3ac8ff, 0xff6af0];
  const A = new THREE.Vector3(-6.4, 2.6, -4.4), B = new THREE.Vector3(6.6, 2.4, -4.2);
  const wirePts = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const p = A.clone().lerp(B, t);
    p.y -= Math.sin(t * Math.PI) * 1.1;
    p.z -= Math.sin(t * Math.PI) * 0.6;
    wirePts.push(p);
    if (i > 0 && i < 28) {
      const b = mesh(new THREE.SphereGeometry(0.09, 8, 6), glow(bulbCols[i % bulbCols.length]), [p.x, p.y - 0.1, p.z], false);
      b.userData.col = bulbCols[i % bulbCols.length];
      group.add(b);
      bulbs.push(b);
    }
  }
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(wirePts), new THREE.LineBasicMaterial({ color: 0x223322 })));
  anim.add((now) => {
    const phase = Math.floor(now / 450);
    bulbs.forEach((b, i) => b.material.color.setHex((i + phase) % 3 ? b.userData.col : 0x333333));
    return true;
  }, true);
  // снегопад
  const n = 600;
  const pos = new Float32Array(n * 3);
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos.set([(r() - 0.5) * 20, r() * 10, -9 + r() * 15], i * 3);
    speed[i] = 0.5 + r() * 0.7;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const [fc, fg] = canvas(32, 32);
  const fgr = fg.createRadialGradient(16, 16, 0, 16, 16, 16);
  fgr.addColorStop(0, 'rgba(255,255,255,1)');
  fgr.addColorStop(1, 'rgba(255,255,255,0)');
  fg.fillStyle = fgr;
  fg.fillRect(0, 0, 32, 32);
  const flakes = heavy(new THREE.Points(geo, new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(fc), size: 0.2, transparent: true, depthWrite: false, opacity: 0.9,
  })));
  group.add(flakes);
  let last = 0;
  anim.add((now) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    for (let i = 0; i < n; i++) {
      let y = pos[i * 3 + 1] - speed[i] * dt;
      if (y < 0) y += 10;
      pos[i * 3 + 1] = y;
      pos[i * 3] += Math.sin(now / 900 + i) * dt * 0.15;
    }
    geo.attributes.position.needsUpdate = true;
    return true;
  }, true);
  return {
    floor: texture(c, renderer),
    floorShape: { w: 16, d: 16 },
    ground: 0xe9f1fa, groundY: -0.03,
    clear: 0xcfe3f2, fog: [0xd6e6f3, 30, 75],
    light: { sky: 0xeef6ff, ground: 0x9ab4d0, hemi: 1.0, sun: 0xffffff, sunI: 1.8 },
    view: { r: 7.0, z: -1.0, el: 45 },
    group,
    wall: null,
    update: anim.run,
  };
}

export const MAP_BUILDERS = {
  felt: buildFelt,
  octagon: buildOctagon,
  ring: buildRing,
  bar: buildBar,
  casino: buildCasino,
  space: buildSpace,
  beach: buildBeach,
  snow: buildSnow,
};

export const MAP_ICONS = {
  felt: '🟩', octagon: '🤼', ring: '🥊', bar: '🍺', casino: '🎰', space: '🪐', beach: '🏖', snow: '❄️',
};
