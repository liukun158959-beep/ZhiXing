// 内置矢量 / 可选 Live2D 渲染；共享动作和 Rust 穿透命中区域。
import type * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display/cubism4";
import { mountBuiltinPet, type BuiltinSkin } from './builtin-pet';

let app: PIXI.Application | null = null;
let model: Live2DModel | null = null;
let lastMotion = "";
let live2d: typeof import("pixi-live2d-display/cubism4") | null = null;
let builtin: ReturnType<typeof mountBuiltinPet> | null = null;

function stopPet() {
  builtin?.destroy(); builtin = null;
  app?.destroy(false, { children: true, texture: true, baseTexture: true });
  app = null; model = null; lastMotion = '';
}

export function startBuiltinPet(canvas: HTMLCanvasElement, skin: BuiltinSkin) {
  stopPet(); builtin = mountBuiltinPet(canvas, skin); lastMotion = 'Idle';
}

const HEADROOM = 72;

function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = () => {
      n -= 1;
      if (n <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export async function startPet(canvas: HTMLCanvasElement, modelUrl: string): Promise<void> {
  stopPet();
  if (!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    throw new Error("Cubism Core 未加载。确认 public/Core/live2dcubismcore.js 存在。");
  }
  const wrap = canvas.parentElement!;
  const viewW = wrap.clientWidth;
  const viewH = wrap.clientHeight;
  if (viewW <= 1 || viewH <= 1) throw new Error(`画布尺寸无效 ${viewW}x${viewH}`);

  const PIXI = await import('pixi.js');
  (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
  live2d = await import("pixi-live2d-display/cubism4");
  live2d.Live2DModel.registerTicker(PIXI.Ticker);
  app = new PIXI.Application({
    view: canvas,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    width: viewW,
    height: viewH,
  });

  model = await live2d.Live2DModel.from(modelUrl, { autoInteract: false });
  app.stage.addChild(model);
  await waitFrames(2);

  const srcW = model.internalModel.originalWidth;
  const srcH = model.internalModel.originalHeight;
  const fitH = Math.max(1, viewH - HEADROOM);
  const baseScale = Math.min(viewW / srcW, fitH / srcH);
  model.scale.set(baseScale);
  model.anchor.set(0.5, 1);
  model.x = viewW * 0.5;
  model.y = viewH - 4;
  await playMotion("Idle");
}

export function currentMotion(): string {
  const playing = model?.internalModel.motionManager.state.currentGroup;
  return playing || lastMotion;
}

// 点击会连点。上一段 Tap 还占着普通优先级时，库会直接拒绝新的一段。
// 先停掉再按强制优先级重播。没有在播的动作要当场开始，避免自动待机先占住 Idle。
let motionTail: Promise<void> = Promise.resolve();
let motionPending = 0;

export function playMotion(group: string): Promise<void> {
  motionPending += 1;
  const finish = () => {
    motionPending -= 1;
  };
  const job =
    motionPending === 1
      ? runMotion(group).finally(finish)
      : motionTail.then(() => runMotion(group)).finally(finish);
  motionTail = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

async function runMotion(group: string): Promise<void> {
  if (builtin) { builtin.play(group); lastMotion = group; return; }
  if (!model) {
    throw new Error("形象还没加载。恢复：确认 public/Core 和 public/skins/kaltsit 都在。");
  }
  const state = model.internalModel.motionManager.state;
  const idle = group === "Idle";
  if (!idle) model.internalModel.motionManager.stopAllMotions();
  const priority = idle ? live2d!.MotionPriority.IDLE : live2d!.MotionPriority.FORCE;
  const ok = await model.motion(group, undefined, priority);
  const idleAlready =
    idle &&
    (state.currentPriority === live2d!.MotionPriority.IDLE ||
      state.currentGroup === "Idle" ||
      state.reservedIdleGroup === "Idle");
  if (!ok && !idleAlready) {
    throw new Error(`动作「${group}」没有播出来。恢复：检查模型里的 ${group} 动作组。`);
  }
  lastMotion = group;
}

// 角色渲染包围盒（CSS 逻辑像素，窗口相对坐标），供 Rust 穿透判定。
export function modelBounds(): { x: number; y: number; w: number; h: number } | null {
  if (builtin) return builtin.bounds();
  if (!model) return null;
  const b = model.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
