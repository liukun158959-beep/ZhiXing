// A small native vector companion. No external model, Core or texture is needed.
export const PET_PALETTES = {
  paper: { name: '纸白', body: '#eee9dc', shade: '#d4caba', line: '#3e4443', accent: '#be9c60' },
  sage: { name: '鼠尾草', body: '#aebca8', shade: '#819980', line: '#303f39', accent: '#e5dfc4' },
  ink: { name: '墨黑', body: '#414a51', shade: '#2e353b', line: '#dedbcf', accent: '#b9c9ba' },
} as const;
export type BuiltinSkin = keyof typeof PET_PALETTES;
export function isBuiltinSkin(value: string): value is BuiltinSkin { return Object.hasOwn(PET_PALETTES, value); }

export function petSvg(skin: BuiltinSkin): string {
  const p = PET_PALETTES[skin];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 170" fill="none" aria-label="tebb 小伴 · ${p.name}" role="img">
    <ellipse cx="80" cy="153" rx="40" ry="5" fill="#343c3b" opacity=".12"/>
    <g class="pet-body" fill="none" stroke="${p.line}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M58 136q-10 11-6 15 11 5 23-10m11 0q12 14 22 9 4-5-7-14" fill="${p.shade}"/>
      <path d="M36 90Q21 83 21 95q1 13 15 15m88-20q15-7 15 5-1 13-15 15" fill="${p.body}"/>
      <path d="M31 104c-4-21 3-49 17-60 6-5 13-6 20-5 3-13 12-20 23-19-1 10-4 16-10 20 30-3 50 21 50 53 0 29-19 49-49 50-30 1-47-11-51-39Z" fill="${p.body}"/>
      <path d="M41 113q9 26 40 26 28 0 41-24" stroke="${p.shade}" stroke-width="6"/>
      <g class="pet-eyes" fill="${p.line}" stroke="none"><rect x="56" y="78" width="7" height="13" rx="3.5"/><rect x="97" y="78" width="7" height="13" rx="3.5"/></g>
      <path d="M73 99q7 7 14 0"/>
      <path d="M48 99h5m55 0h5" stroke="${p.accent}" stroke-width="5"/>
      <path d="m77 120 4-5 5 5-5 5Z" fill="${p.accent}" stroke="none"/>
    </g></svg>`;
}

export function mountBuiltinPet(canvas: HTMLCanvasElement, skin: BuiltinSkin) {
  const host = document.createElement('div');
  host.className = 'builtin-pet'; host.innerHTML = petSvg(skin);
  host.style.cssText = 'position:absolute;width:160px;height:170px;left:50%;bottom:20px;transform:translateX(-50%);user-select:none;';
  const style = document.createElement('style');
  style.textContent = `.builtin-pet svg{width:100%;height:100%;overflow:visible;pointer-events:none}.builtin-pet .pet-body{transform-origin:80px 145px;animation:pet-breathe 3.6s ease-in-out infinite}.builtin-pet .pet-eyes{transform-origin:80px 85px;animation:pet-blink 6.3s infinite}.builtin-pet[data-reacting] .pet-body{animation:pet-tap .5s ease}.builtin-pet[data-reacting] .pet-eyes{animation:none}@keyframes pet-breathe{50%{transform:translateY(-3px) scaleY(1.025)}}@keyframes pet-blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.08)}}@keyframes pet-tap{35%{transform:translateY(4px) scale(1.07,.91)}70%{transform:translateY(-7px) scale(.96,1.05)}}@media(prefers-reduced-motion:reduce){.builtin-pet .pet-body,.builtin-pet .pet-eyes{animation:none!important}}`;
  host.appendChild(style); canvas.parentElement!.appendChild(host); canvas.style.visibility = 'hidden';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    bounds() { const r = host.getBoundingClientRect(); return { x: r.x+18, y: r.y+10, w: r.width-36, h: r.height-15 }; },
    play(group: string) { if (group !== 'Idle') { clearTimeout(timer); host.removeAttribute('data-reacting'); void host.offsetWidth; host.setAttribute('data-reacting', ''); timer = setTimeout(() => host.removeAttribute('data-reacting'), 520); } },
    destroy() { clearTimeout(timer); host.remove(); canvas.style.visibility = ''; },
  };
}
