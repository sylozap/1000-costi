// Самосвал нарисован SVG: чёткие детали на любом экране, без загрузки изображений.
export function showDumpTruck(layer, name, score) {
  // Несколько самосвалов от одного события не перекрывают друг друга.
  layer.querySelector('.dump-scene')?.remove();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = document.createElement('div');
  scene.className = 'fx dump-scene' + (reduced ? ' dump-reduced' : '');
  scene.setAttribute('role', 'status');
  scene.innerHTML = `
    <div class="dump-halo"></div>
    <div class="dump-heading"><small>СЛУЖБА ВЫВОЗА ОЧКОВ</small><strong>САМОСВАЛ!</strong><span class="dump-player"></span></div>
    <div class="dump-road"></div>
    <div class="dump-rig">
      <div class="dump-smoke"><i></i><i></i><i></i></div>
      <svg class="dump-truck" viewBox="0 0 360 200" aria-hidden="true">
        <ellipse cx="180" cy="179" rx="158" ry="12" fill="#000" opacity=".28"/>
        <path d="M48 132h255v26H48z" fill="#252c38" stroke="#101722" stroke-width="4"/>
        <path d="m137 133 70-43" stroke="#abb7c3" stroke-width="10"/>
        <path d="m137 133 70-43" stroke="#e5eef5" stroke-width="4"/>
        <g class="dump-bed">
          <path d="M32 62h190l-12 69H56z" fill="#e7a62a" stroke="#633f19" stroke-width="4" stroke-linejoin="round"/>
          <path d="M29 59h198v12H29z" fill="#ffe296" stroke="#633f19" stroke-width="3"/>
          <path d="m67 80 12 39m32-39 5 39m34-39-2 39m35-39-6 39" stroke="#b4761d" stroke-width="7"/>
          <path d="M43 74h171" stroke="#fff0b9" stroke-width="3"/>
          <rect x="112" y="81" width="61" height="29" rx="5" fill="#49391f"/>
          <text class="dump-load-number" x="142" y="103" fill="#ffe5a0" font-size="23" font-family="sans-serif" font-weight="900" text-anchor="middle"></text>
        </g>
        <path d="M225 65h57l38 46v39h-95z" fill="#f3bb3b" stroke="#633f19" stroke-width="4" stroke-linejoin="round"/>
        <path d="M239 77h36l27 34h-63z" fill="#80c9db" stroke="#29465a" stroke-width="4"/>
        <path d="M243 81h24l-24 25z" fill="#d2f4f5" opacity=".7"/>
        <path d="M236 121h22" stroke="#694a1f" stroke-width="4"/>
        <rect x="301" y="128" width="21" height="11" rx="3" fill="#fff1b7"/>
        <rect x="311" y="146" width="20" height="13" rx="3" fill="#aab7c4"/>
        <rect x="224" y="48" width="26" height="12" rx="5" fill="#ff7c39" class="dump-beacon"/>
        <g class="dump-wheel" style="--wheel-x:80px"><circle cx="80" cy="157" r="25" fill="#17202b" stroke="#080d14" stroke-width="4"/><circle cx="80" cy="157" r="12" fill="#c3cbd0"/><path d="M80 146v22m-11-11h22" stroke="#596777" stroke-width="4"/></g>
        <g class="dump-wheel" style="--wheel-x:153px"><circle cx="153" cy="157" r="25" fill="#17202b" stroke="#080d14" stroke-width="4"/><circle cx="153" cy="157" r="12" fill="#c3cbd0"/><path d="M153 146v22m-11-11h22" stroke="#596777" stroke-width="4"/></g>
        <g class="dump-wheel" style="--wheel-x:279px"><circle cx="279" cy="157" r="25" fill="#17202b" stroke="#080d14" stroke-width="4"/><circle cx="279" cy="157" r="12" fill="#c3cbd0"/><path d="M279 146v22m-11-11h22" stroke="#596777" stroke-width="4"/></g>
      </svg>
    </div>
    <div class="dump-spill" aria-hidden="true"></div>
    <div class="dump-result"><strong>0</strong><span>СЧЁТ ВЫВЕЗЕН</span></div>`;
  scene.querySelector('.dump-player').textContent = name;
  scene.querySelector('.dump-load-number').textContent = score;
  const spill = scene.querySelector('.dump-spill');
  for (let i = 0; i < 14; i++) {
    const piece = document.createElement('span');
    piece.textContent = i % 3 ? '●' : '+5';
    piece.style.setProperty('--dx', `${-65 + (i * 43 % 130)}px`);
    piece.style.setProperty('--dy', `${50 + (i * 19 % 75)}px`);
    piece.style.setProperty('--spin', `${i % 2 ? -180 : 210}deg`);
    piece.style.setProperty('--delay', `${i * 28}ms`);
    spill.appendChild(piece);
  }
  layer.appendChild(scene);
  window.setTimeout(() => scene.remove(), reduced ? 2600 : 4200);
}
