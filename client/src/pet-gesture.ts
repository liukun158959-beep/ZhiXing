// 桌宠手势：点一下换短台词，拖过阈值才算拖。不打模型。

export const DRAG_PX = 6;
export const BUBBLE_MS = 4000;

export const LINES = [
  "我在，需要处理什么？",
  "点一下，继续我们的对话。",
  "今天的安排在主窗口里。",
  "我在。",
  "可以把任务交给我。",
  "需要谈话的话，打开主窗口。",
];

export type Gesture =
  | { kind: "idle" }
  | {
      kind: "down";
      x: number;
      y: number;
      lastX: number;
      lastY: number;
      t: number;
      moved: boolean;
      vx: number;
      vy: number;
    };

export type Bubble = {
  open: boolean;
  text: string;
  until: number;
  error: boolean;
  index: number;
};

export const IDLE: Gesture = { kind: "idle" };

export function emptyBubble(): Bubble {
  return { open: false, text: "", until: 0, error: false, index: -1 };
}

export function passedDrag(dx: number, dy: number): boolean {
  return dx * dx + dy * dy >= DRAG_PX * DRAG_PX;
}

export function pointerDown(x: number, y: number, t: number): Gesture {
  return { kind: "down", x, y, lastX: x, lastY: y, t, moved: false, vx: 0, vy: 0 };
}

export function pointerMove(
  gesture: Gesture,
  x: number,
  y: number,
  t: number,
): { gesture: Gesture; startedDrag: boolean; dx: number; dy: number } {
  if (gesture.kind !== "down") return { gesture, startedDrag: false, dx: 0, dy: 0 };
  const moved = gesture.moved || passedDrag(x - gesture.x, y - gesture.y);
  const startedDrag = moved && !gesture.moved;
  const dx = x - gesture.lastX;
  const dy = y - gesture.lastY;
  const dt = Math.max(1, t - gesture.t);
  return {
    gesture: {
      kind: "down",
      x: gesture.x,
      y: gesture.y,
      lastX: x,
      lastY: y,
      t,
      moved,
      vx: dx / dt,
      vy: dy / dt,
    },
    startedDrag,
    dx: moved ? dx : 0,
    dy: moved ? dy : 0,
  };
}

export function pointerUp(gesture: Gesture): { moved: boolean; vx: number; vy: number } {
  if (gesture.kind !== "down") return { moved: false, vx: 0, vy: 0 };
  return { moved: gesture.moved, vx: gesture.vx, vy: gesture.vy };
}

export function tapBubble(bubble: Bubble, now: number): Bubble {
  const index = (bubble.index + 1) % LINES.length;
  return { open: true, text: LINES[index], until: now + BUBBLE_MS, error: false, index };
}

export function errorBubble(text: string): Bubble {
  return { open: true, text, until: 0, error: true, index: -1 };
}

export function dismissBubble(bubble: Bubble): Bubble {
  return { ...bubble, open: false, until: 0 };
}

export function bubbleDue(bubble: Bubble, now: number): boolean {
  return bubble.open && !bubble.error && bubble.until > 0 && now >= bubble.until;
}
