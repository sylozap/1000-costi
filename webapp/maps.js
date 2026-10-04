// Карты (столы) для 3D-сцены. Всё рисуется кодом: текстуры на canvas, декор из простых фигур.
// Пол — плоскость 16×16 единиц; 1 единица = 64 px текстуры 1024×1024, центр стола в (512, 512).
// Камера видит примерно x ∈ [−4.3; 4.3], z ∈ [−4; 2.4]: декор ставим по краям этой зоны.
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

function vignette(g, inner, outer, color) {
  const v = g.createRadialGradient(SIZE / 2, SIZE / 2 - 40, inner, SIZE / 2, SIZE / 2, outer);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, color);
  g.fillStyle = v;
  g.fillRect(0, 0, SIZE, SIZE);
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

function mesh(geo, material, [x, y, z] = [0, 0, 0], shadow = true) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

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

/** Колебание объекта после удара кубика: смещение вдоль нормали с затуханием. */
function wobble(obj, normal, amp) {
  obj.userData.wob = { t0: performance.now(), base: obj.position.clone(), normal, amp };
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

// ---------- октагон MMA ----------

function buildOctagon(renderer) {
  const A = 3.45; // апофема клетки
  const [c, g] = canvas();
  g.fillStyle = '#07080b';
  g.fillRect(0, 0, SIZE, SIZE);
  // фартук за сеткой
  poly(g, octagon(512, 512, (A + 0.9) * PX));
  g.fillStyle = '#121318';
  g.fill();
  // мат
  poly(g, octagon(512, 512, A * PX));
  const mg = g.createRadialGradient(512, 500, 30, 512, 512, A * PX * 1.1);
  mg.addColorStop(0, '#3a4256');
  mg.addColorStop(0.7, '#262c3b');
  mg.addColorStop(1, '#1a1e29');
  g.fillStyle = mg;
  g.fill();
  grain(g, SIZE, SIZE, 14, 11);
  // углы бойцов
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
  // разметка
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 4;
  poly(g, octagon(512, 512, (A - 0.25) * PX));
  g.stroke();
  // логотип в центре
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
  // надписи у сетки
  g.font = '800 30px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.fillText('ROUND 1000', 512, 512 - (A - 0.6) * PX);
  vignette(g, 4 * PX, 7.5 * PX, 'rgba(0,0,0,0.75)');

  const group = new THREE.Group();
  const pts = octagon(0, 0, A);
  const side = 2 * A * Math.tan(Math.PI / 8);
  const H = 3.1;
  const postMat = mat(0x0d0d0f, { roughness: 0.45 });
  pts.forEach(([x, z]) => group.add(mesh(new THREE.CylinderGeometry(0.19, 0.19, H, 16), postMat, [x, H / 2, z])));
  // сетка-рабица
  const [lc, lg] = canvas(64, 64);
  lg.strokeStyle = '#b8bec6';
  lg.lineWidth = 4;
  lg.beginPath();
  lg.moveTo(0, 0); lg.lineTo(64, 64);
  lg.moveTo(64, 0); lg.lineTo(0, 64);
  lg.stroke();
  const fenceH = H - 0.55;
  const linkTex = texture(lc, renderer, [side / 0.32, fenceH / 0.32]);
  const fenceMat = new THREE.MeshStandardMaterial({
    map: linkTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.35,
  });
  const padMat = mat(0x111114, { roughness: 0.5 });
  const railMat = mat(0x1a1a1d, { metalness: 0.6, roughness: 0.3 });
  const panels = [];
  for (let k = 0; k < 8; k++) {
    const phi = (k * Math.PI) / 4; // нормаль стороны (плоские стороны — по осям)
    const nx = Math.cos(phi), nz = Math.sin(phi);
    const rotY = Math.atan2(-nx, -nz);
    const fence = mesh(new THREE.PlaneGeometry(side, fenceH), fenceMat, [nx * A, 0.45 + fenceH / 2, nz * A], false);
    fence.rotation.y = rotY;
    const pad = mesh(new THREE.BoxGeometry(side, 0.45, 0.28), padMat, [nx * (A + 0.05), 0.225, nz * (A + 0.05)]);
    pad.rotation.y = rotY;
    const rail = mesh(new THREE.BoxGeometry(side, 0.14, 0.14), railMat, [nx * A, H - 0.05, nz * A]);
    rail.rotation.y = rotY;
    group.add(fence, pad, rail);
    panels.push({ phi, objs: [fence, rail], normal: new THREE.Vector3(nx, 0, nz) });
  }
  return {
    floor: texture(c, renderer),
    clear: 0x050608,
    light: { sky: 0xdfe8ff, ground: 0x10131c, hemi: 0.85, sun: 0xffffff, sunI: 2.2 },
    group,
    wall: { type: 'circle', r: A - 0.55 },
    sounds: 'fight',
    onWall(p) {
      const a = Math.atan2(p.z, p.x);
      let best = panels[0], bd = 9;
      for (const pn of panels) {
        const d = Math.abs(Math.atan2(Math.sin(a - pn.phi), Math.cos(a - pn.phi)));
        if (d < bd) { bd = d; best = pn; }
      }
      best.objs.forEach((o) => wobble(o, best.normal, 0.09));
    },
    update(now) { return updateWobbles(group, now); },
  };
}

// ---------- боксёрский ринг ----------

function buildRing(renderer) {
  const H = 3.55;
  const [c, g] = canvas();
  g.fillStyle = '#0a0d14';
  g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = '#163a6b';
  g.fillRect(u(-H - 0.8), u(-H - 0.8), (2 * H + 1.6) * PX, (2 * H + 1.6) * PX);
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
  vignette(g, 4 * PX, 7.5 * PX, 'rgba(0,0,0,0.6)');

  const group = new THREE.Group();
  const corners = [[-H, -H, 0xd62828], [H, -H, 0xf4f4f4], [H, H, 0x2463eb], [-H, H, 0xf4f4f4]];
  for (const [x, z, col] of corners) {
    group.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 12), mat(0xb8bcc4, { metalness: 0.8, roughness: 0.3 }),
      [x, 1.4, z]));
    group.add(mesh(new THREE.BoxGeometry(0.42, 2.2, 0.42), mat(col, { roughness: 0.45 }), [x, 1.35, z]));
  }
  const ropes = [];
  const ropeCols = [0x2463eb, 0xf4f4f4, 0xd62828];
  [0.75, 1.4, 2.05].forEach((y, i) => {
    const rm = mat(ropeCols[i], { roughness: 0.4 });
    for (const [nx, nz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const r = mesh(new THREE.CylinderGeometry(0.065, 0.065, 2 * H, 10), rm, [nx * H, y, nz * H]);
      if (nz) r.rotation.z = Math.PI / 2; // канат вдоль x
      else r.rotation.x = Math.PI / 2; // канат вдоль z
      group.add(r);
      ropes.push({ obj: r, normal: new THREE.Vector3(nx, 0, nz) });
    }
  });
  return {
    floor: texture(c, renderer),
    clear: 0x05070b,
    light: { sky: 0xffffff, ground: 0x1a2030, hemi: 1.0, sun: 0xffffff, sunI: 2.0 },
    group,
    wall: { type: 'box', hx: H - 0.55, hz: H - 0.55 },
    sounds: 'box',
    onWall(p) {
      const n = Math.abs(p.x) > Math.abs(p.z) ? new THREE.Vector3(Math.sign(p.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(p.z));
      for (const r of ropes) if (r.normal.dot(n) > 0.9) wobble(r.obj, n, 0.12);
    },
    update(now) { return updateWobbles(group, now); },
  };
}

// ---------- барная стойка ----------

function buildBar(renderer) {
  const [c, g] = canvas();
  const rnd = rng(31);
  const board = 1.15 * PX;
  for (let y = 0, i = 0; y < SIZE; y += board, i++) {
    const tint = 0.85 + rnd() * 0.3;
    g.fillStyle = `rgb(${Math.round(112 * tint)},${Math.round(66 * tint)},${Math.round(33 * tint)})`;
    g.fillRect(0, y, SIZE, board);
    for (let k = 0; k < 26; k++) {
      g.strokeStyle = `rgba(${40 + rnd() * 30},${18 + rnd() * 12},5,${0.18 + rnd() * 0.25})`;
      g.lineWidth = 1 + rnd() * 2.5;
      g.beginPath();
      const y0 = y + rnd() * board;
      const amp = 2 + rnd() * 5, freq = 0.004 + rnd() * 0.01, ph = rnd() * 6;
      for (let x = 0; x <= SIZE; x += 16) g.lineTo(x, y0 + Math.sin(x * freq + ph) * amp);
      g.stroke();
    }
    if (rnd() < 0.6) {
      g.fillStyle = 'rgba(50,22,6,0.45)';
      g.beginPath();
      g.ellipse(rnd() * SIZE, y + board / 2, 14 + rnd() * 10, 6 + rnd() * 4, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(20,8,2,0.75)';
    g.fillRect(0, y, SIZE, 3);
  }
  // следы от кружек
  for (const [x, z, r] of [[-3.2, -2.2, 0.55], [2.4, 1.6, 0.5], [-1.2, 1.9, 0.45], [3.4, -0.6, 0.5]]) {
    g.strokeStyle = 'rgba(30,12,2,0.28)';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(u(x), u(z), r * PX, 0.3, Math.PI * 1.85);
    g.stroke();
  }
  const sh = g.createRadialGradient(470, 420, 20, 512, 512, 520);
  sh.addColorStop(0, 'rgba(255,220,150,0.22)');
  sh.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = sh;
  g.fillRect(0, 0, SIZE, SIZE);

  const group = new THREE.Group();
  // кружка пива на подставке
  const mx = 3.75, mz = -2.75;
  group.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.04, 32), mat(0xd8c49a, { roughness: 0.9 }), [mx, 0.02, mz]));
  group.add(mesh(new THREE.CylinderGeometry(0.4, 0.37, 1.05, 32), mat(0xe39b1f, { roughness: 0.25, transparent: true, opacity: 0.88 }),
    [mx, 0.57, mz]));
  group.add(mesh(new THREE.CylinderGeometry(0.43, 0.41, 0.28, 32), mat(0xfff6e0, { roughness: 0.95 }), [mx, 1.2, mz]));
  group.add(mesh(new THREE.CylinderGeometry(0.47, 0.44, 1.32, 32, 1, true),
    mat(0xffffff, { transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide }), [mx, 0.7, mz], false));
  const handle = mesh(new THREE.TorusGeometry(0.3, 0.07, 10, 24, Math.PI), mat(0xffffff, { transparent: true, opacity: 0.35, roughness: 0.05 }),
    [mx + 0.47, 0.72, mz]);
  handle.rotation.z = -Math.PI / 2;
  group.add(handle);
  // миска с орешками
  const bx = -3.85, bz = -2.5;
  group.add(mesh(new THREE.SphereGeometry(0.6, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(0x8c2f1b, { side: THREE.DoubleSide, roughness: 0.4 }),
    [bx, 0.6, bz]));
  const nutMat = mat(0xc89048, { roughness: 0.8 });
  const r2 = rng(5);
  for (let i = 0; i < 14; i++) {
    const a = r2() * Math.PI * 2, d = r2() * 0.38;
    group.add(mesh(new THREE.SphereGeometry(0.11, 8, 6), nutMat, [bx + Math.cos(a) * d, 0.5 + r2() * 0.08, bz + Math.sin(a) * d], false));
  }
  return {
    floor: texture(c, renderer),
    clear: 0x140a05,
    light: { sky: 0xffe2b0, ground: 0x2a1406, hemi: 1.0, sun: 0xffd9a0, sunI: 2.0 },
    group,
    wall: null,
    sounds: 'bar',
  };
}

// ---------- казино (крэпс) ----------

function buildCasino(renderer) {
  const [c, g] = canvas();
  g.fillStyle = '#7a1119';
  g.fillRect(0, 0, SIZE, SIZE);
  grain(g, SIZE, SIZE, 16, 41);
  g.strokeStyle = 'rgba(255,240,200,0.85)';
  g.fillStyle = 'rgba(255,240,200,0.88)';
  g.lineWidth = 5;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // pass line — дуга у игрока
  g.beginPath();
  g.ellipse(512, u(-1.5), 5.4 * PX, 3.5 * PX, 0, 0.12 * Math.PI, 0.88 * Math.PI);
  g.stroke();
  g.beginPath();
  g.ellipse(512, u(-1.5), 4.6 * PX, 2.9 * PX, 0, 0.1 * Math.PI, 0.9 * Math.PI);
  g.stroke();
  g.font = '800 40px Georgia, serif';
  g.fillText('PASS LINE', 512, u(1.75));
  // поле
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
  vignette(g, 4 * PX, 7.5 * PX, 'rgba(0,0,0,0.6)');

  const group = new THREE.Group();
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
  const wall = mesh(new THREE.BoxGeometry(10, 1.0, 0.35), [
    mat(0x111111), mat(0x111111), mat(0x3b2412), mat(0x111111),
    new THREE.MeshStandardMaterial({ map: texture(pc, renderer, [10 / 0.3, 1 / 0.3]), roughness: 0.8 }), mat(0x111111),
  ], [0, 0.5, wallZ]);
  group.add(wall);
  group.add(mesh(new THREE.BoxGeometry(10, 0.3, 0.9), mat(0x4a2a12, { roughness: 0.35 }), [0, 1.12, wallZ - 0.25]));
  // стопки фишек
  const chipCols = [0xd62828, 0x1f8a4c, 0x111111, 0xf4f4f4, 0x2463eb];
  const stacks = [[-3.95, -1.7, 7, 0], [-3.4, -2.45, 4, 1], [3.9, -2.1, 9, 2], [3.75, -0.9, 5, 3], [-4.05, -0.6, 3, 4]];
  for (const [x, z, n, ci] of stacks) {
    for (let i = 0; i < n; i++) {
      const col = chipCols[(ci + (i % 3 === 2 ? 1 : 0)) % chipCols.length];
      const chip = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.075, 24), mat(col, { roughness: 0.4 }), [x + (i % 2) * 0.02, 0.04 + i * 0.08, z]);
      group.add(chip);
    }
  }
  return {
    floor: texture(c, renderer),
    clear: 0x0d0405,
    light: { sky: 0xfff3dc, ground: 0x2a0a0d, hemi: 1.05, sun: 0xffffff, sunI: 1.9 },
    group,
    wall: { type: 'back', z: wallZ + 0.7 },
    sounds: 'casino',
    onWall() { wobble(wall, new THREE.Vector3(0, 0, -1), 0.03); },
    update(now) { return updateWobbles(group, now); },
  };
}

// ---------- космос ----------

function buildSpace(renderer) {
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
  const platTop = new THREE.MeshStandardMaterial({ map: texture(c, renderer), roughness: 0.25, metalness: 0.3 });
  const platSide = mat(0x0e1440, { metalness: 0.6, roughness: 0.3 });
  const plat = mesh(new THREE.CylinderGeometry(R, R * 0.92, 0.3, 64), [platSide, platTop, platSide], [0, -0.15, 0], false);
  group.add(plat);
  const rim = mesh(new THREE.TorusGeometry(R, 0.06, 10, 96), new THREE.MeshBasicMaterial({ color: 0x5ff2ff }), [0, 0.0, 0], false);
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
  // звёзды
  const n = 1800;
  const pos = new Float32Array(n * 3);
  const r = rng(77);
  for (let i = 0; i < n; i++) {
    const th = r() * Math.PI * 2, ph = Math.acos(r() * 2 - 1), d = 26 + r() * 8;
    pos.set([d * Math.sin(ph) * Math.cos(th), d * Math.cos(ph) - 6, d * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  group.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.14, sizeAttenuation: true })));
  // планета с кольцом
  const [plc, plg] = canvas(256, 128);
  const pgr = plg.createLinearGradient(0, 0, 0, 128);
  ['#f2b880', '#c97a4a', '#f5d0a0', '#a85a35', '#e9b07a', '#c46a40'].forEach((col, i, a) => pgr.addColorStop(i / (a.length - 1), col));
  plg.fillStyle = pgr;
  plg.fillRect(0, 0, 256, 128);
  const planet = mesh(new THREE.SphereGeometry(2.4, 48, 24), new THREE.MeshStandardMaterial({ map: texture(plc, renderer), roughness: 0.9 }),
    [6.6, -3.2, -6.5], false);
  const ring = mesh(new THREE.RingGeometry(3.0, 4.2, 64), new THREE.MeshBasicMaterial({ color: 0xe8c9a0, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    [6.6, -3.2, -6.5], false);
  ring.rotation.set(-1.2, 0.3, 0);
  group.add(planet, ring);
  const moon = mesh(new THREE.SphereGeometry(0.7, 24, 12), mat(0xb9c2d8, { roughness: 1 }), [-6.2, -2.0, -4.8], false);
  group.add(moon);
  return {
    floor: null,
    clear: 0x02030b,
    light: { sky: 0xbfd4ff, ground: 0x0a0a30, hemi: 0.95, sun: 0xffffff, sunI: 2.1 },
    group,
    wall: null,
    sounds: null,
  };
}

// ---------- пляж ----------

function buildBeach(renderer) {
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
  // мокрый песок, пена и вода у дальнего края
  const edge = (x) => u(-3.3) + Math.sin(x * 0.012) * 14 + Math.sin(x * 0.031 + 1) * 6;
  const shape = (off) => {
    g.beginPath();
    g.moveTo(0, 0);
    for (let x = 0; x <= SIZE; x += 8) g.lineTo(x, edge(x) + off);
    g.lineTo(SIZE, 0);
    g.closePath();
  };
  shape(28);
  g.fillStyle = 'rgba(150,110,60,0.35)';
  g.fill();
  shape(0);
  const wg = g.createLinearGradient(0, 0, 0, u(-3.3));
  wg.addColorStop(0, '#0d5e8f');
  wg.addColorStop(0.75, '#1a9bb8');
  wg.addColorStop(1, '#5fd3d6');
  g.fillStyle = wg;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 9;
  g.beginPath();
  for (let x = 0; x <= SIZE; x += 8) g.lineTo(x, edge(x) - 2);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.lineWidth = 4;
  g.beginPath();
  for (let x = 0; x <= SIZE; x += 8) g.lineTo(x, edge(x) - 26 + Math.sin(x * 0.05) * 4);
  g.stroke();
  // морская звезда и ракушки
  const star = (x, y, rr, rot) => {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = rot + (i * Math.PI) / 5, d = i % 2 ? rr * 0.42 : rr;
      g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }
    g.closePath();
    g.fillStyle = '#e8743b';
    g.fill();
    g.fillStyle = 'rgba(255,220,180,0.7)';
    for (let i = 0; i < 5; i++) {
      const a = rot + (i * 2 * Math.PI) / 5;
      g.beginPath();
      g.arc(x + Math.cos(a) * rr * 0.55, y + Math.sin(a) * rr * 0.55, 3, 0, Math.PI * 2);
      g.fill();
    }
  };
  star(u(3.7), u(1.4), 36, 0.4);
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
  shell(u(-3.8), u(-1.3), 26, 0.3);
  shell(u(-3.3), u(1.8), 20, -0.6);
  shell(u(3.2), u(-1.9), 18, 1.1);

  const group = new THREE.Group();
  return {
    floor: texture(c, renderer),
    clear: 0x87c9e8,
    light: { sky: 0xfff6dc, ground: 0x8a7550, hemi: 1.15, sun: 0xfff1d0, sunI: 2.3 },
    group,
    wall: null,
    sounds: null,
  };
}

// ---------- снег ----------

function buildSnow(renderer) {
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
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.95)' : 'rgba(150,190,255,0.7)';
    g.fillRect(r() * SIZE, r() * SIZE, 1.5, 1.5);
  }
  vignette(g, 4 * PX, 8 * PX, 'rgba(120,150,190,0.35)');

  const group = new THREE.Group();
  // ёлочки по краям
  const tree = (x, z, s) => {
    group.add(mesh(new THREE.CylinderGeometry(0.1 * s, 0.12 * s, 0.4 * s, 8), mat(0x5b3a1e), [x, 0.2 * s, z]));
    [[0.9, 0.9, 0.55], [0.7, 0.8, 1.05], [0.48, 0.7, 1.5]].forEach(([rad, h, y]) => {
      group.add(mesh(new THREE.ConeGeometry(rad * s, h * s, 10), mat(0x1f5a3a, { roughness: 0.9 }), [x, y * s, z]));
      group.add(mesh(new THREE.ConeGeometry(rad * s * 0.7, h * s * 0.35, 10), mat(0xffffff, { roughness: 1 }),
        [x, (y + h * 0.33) * s, z], false));
    });
  };
  tree(-4.0, -2.9, 1.15);
  tree(4.1, -2.4, 1.0);
  tree(-4.5, -0.6, 0.8);
  // снегопад
  const n = 420;
  const pos = new Float32Array(n * 3);
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos.set([(r() - 0.5) * 12, r() * 8, -5 + r() * 9], i * 3);
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
  const flakes = new THREE.Points(geo, new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(fc), size: 0.16, transparent: true, depthWrite: false, opacity: 0.9,
  }));
  group.add(flakes);
  let last = 0;
  return {
    floor: texture(c, renderer),
    clear: 0xcfe3f2,
    light: { sky: 0xeef6ff, ground: 0x9ab4d0, hemi: 1.0, sun: 0xffffff, sunI: 1.8 },
    group,
    wall: null,
    sounds: null,
    update(now) {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      for (let i = 0; i < n; i++) {
        let y = pos[i * 3 + 1] - speed[i] * dt;
        if (y < 0) y += 8;
        pos[i * 3 + 1] = y;
        pos[i * 3] += Math.sin(now / 900 + i) * dt * 0.15;
      }
      geo.attributes.position.needsUpdate = true;
      return true;
    },
  };
}

export const MAP_BUILDERS = {
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
