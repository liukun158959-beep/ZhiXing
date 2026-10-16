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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-label="tebb 圆点 · ${p.name}" role="img">
    <circle class="pet-body" cx="32" cy="32" r="29.5" fill="${p.body}" stroke="${p.shade}" stroke-width="1.5"/>
    <g class="pet-eyes" fill="${p.line}"><rect x="22" y="26" width="5" height="11" rx="2.5"/><rect x="37" y="26" width="5" height="11" rx="2.5"/></g></svg>`;
}

export function mountBuiltinPet(canvas: HTMLCanvasElement, skin: BuiltinSkin, size = 48) {
  const host = document.createElement('div');
  host.className = 'builtin-pet'; host.innerHTML = petSvg(skin);
  host.style.cssText = `position:absolute;width:${size}px;height:${size}px;left:50%;bottom:20px;transform:translateX(-50%);user-select:none;`;
  const style = document.createElement('style');
  style.textContent = `.builtin-pet svg{width:100%;height:100%;overflow:visible;pointer-events:none}.builtin-pet .pet-body{transform-origin:32px 32px;animation:pet-breathe 3.6s ease-in-out infinite}.builtin-pet[data-active]{filter:drop-shadow(0 0 5px #aebca888)}.builtin-pet .pet-eyes{transform-origin:32px 31px;animation:pet-blink 6.3s infinite}.builtin-pet[data-reacting] .pet-body{animation:pet-tap .5s ease}.builtin-pet[data-reacting] .pet-eyes{animation:none}@keyframes pet-breathe{50%{transform:translateY(-3px) scale(1.025)}}@keyframes pet-blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.08)}}@keyframes pet-tap{35%{transform:translateY(4px) scale(1.07,.91)}70%{transform:translateY(-7px) scale(.96,1.05)}}@media(prefers-reduced-motion:reduce){.builtin-pet .pet-body,.builtin-pet .pet-eyes{animation:none!important}}`;
  host.appendChild(style); canvas.parentElement!.appendChild(host); canvas.style.visibility = 'hidden';
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    bounds() { const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
    active(value: boolean) { host.toggleAttribute('data-active', value); },
    play(group: string) { if (group !== 'Idle') { clearTimeout(timer); host.removeAttribute('data-reacting'); void host.offsetWidth; host.setAttribute('data-reacting', ''); timer = setTimeout(() => host.removeAttribute('data-reacting'), 520); } },
    destroy() { clearTimeout(timer); host.remove(); canvas.style.visibility = ''; },
  };
}
