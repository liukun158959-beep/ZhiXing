import { useLayoutEffect, type RefObject } from 'react';

export function resizeComposer(input: HTMLTextAreaElement) {
  const style = getComputedStyle(input);
  const min = parseFloat(style.minHeight) || 44;
  const max = parseFloat(style.maxHeight) || 240;
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  input.style.height = '0px';
  const height = Math.max(min, Math.min(max, input.scrollHeight + border));
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight + border > height + 1 ? 'auto' : 'hidden';
}

// Also handle a restored draft, changed workspace width, and reopening a hidden view.
export function useAutoGrowInput(ref: RefObject<HTMLTextAreaElement>, value: string, context: string) {
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const resize = () => resizeComposer(input);
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width !== previousWidth) { previousWidth = width; resize(); }
    });
    let previousWidth = input.getBoundingClientRect().width;
    observer?.observe(input);
    window.addEventListener?.('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener?.('resize', resize); };
  }, [ref, value, context]);
}
