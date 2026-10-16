import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { rpc, type BackendInfo } from './api';
import { PET_PALETTES, petSvg, type BuiltinSkin } from '../builtin-pet';

type Preferences = { ok: boolean; skin: string; live2d_available: boolean };
export function PetSettings({ info, debug = false }: { info: BackendInfo | null; debug?: boolean }) {
  const [prefs, setPrefs] = useState<Preferences>({ ok: true, skin: 'paper', live2d_available: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    if (info && !debug) void rpc<Preferences>(info, 'load_pet_preferences').then(value => { if (live) setPrefs(value); }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [info?.port, info?.token, debug]);
  async function choose(skin: string) {
    if (busy) return;
    if (debug) { setPrefs(old => ({ ...old, skin })); setNotice('演示外观，未修改实际设置。'); return; }
    if (!info) { setError('本地后端尚未连接。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await rpc<Preferences>(info, 'save_pet_preferences', { skin });
      if (!value.ok) throw new Error('桌宠皮肤未能保存');
      setPrefs(value); setNotice('已保存，桌宠会自动切换；隐藏时可点击「唤出桌宠」。');
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section className="pet-settings mb-6 border border-border bg-card/80 p-5" aria-label="桌宠形象">
    <header><div><h2 className="text-lg font-semibold">桌宠形象</h2><p>小伴 · tebb 的轻量桌面形象。外观独立于聊天伙伴与 Agent 人格。</p></div><button className="desk-menu-item" disabled={!isTauri()} onClick={() => void invoke('set_pet_visible', { visible: true }).catch(e => setError(String(e)))}>唤出桌宠</button></header>
    <div className="pet-skin-options">{Object.entries(PET_PALETTES).map(([id, palette]) => <button key={id} type="button" aria-pressed={prefs.skin === id} disabled={busy} onClick={() => void choose(id)}>
      <img src={`data:image/svg+xml,${encodeURIComponent(petSvg(id as BuiltinSkin))}`} alt={`小伴 · ${palette.name}`} /><strong>{palette.name}</strong><small>内置 · 离线可用</small>
    </button>)}<button type="button" aria-pressed={prefs.skin === 'kaltsit'} disabled={busy || !prefs.live2d_available} onClick={() => void choose('kaltsit')}><span className="pet-live2d-mark" aria-hidden="true">K.</span><strong>凯尔希</strong><small>{prefs.live2d_available ? '已有 Live2D 形象' : '请先安装 Live2D 素材'}</small></button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
