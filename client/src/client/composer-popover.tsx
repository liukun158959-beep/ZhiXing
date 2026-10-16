import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export function pickerBounds(rect: {left:number;top:number;bottom:number;width:number}, viewport: {width:number;height:number}) {
  const width = Math.min(380, Math.max(0, viewport.width - 16));
  const above = Math.max(0, rect.top - 16), below = Math.max(0, viewport.height - rect.bottom - 16);
  const upwards = above >= below;
  const height = Math.min(270, upwards ? above : below);
  return {position:'fixed' as const, left:Math.max(8,Math.min(rect.left,viewport.width-width-8)),
    top:upwards ? 'auto' : rect.bottom+8, width, maxHeight:height, bottom:upwards ? viewport.height-rect.top+8 : 'auto', zIndex:100};
}

export function ComposerPicker({anchor, id, label, className, onClose, children}: {
  anchor:RefObject<HTMLElement>; id:string; label:string; className:string; onClose:()=>void; children:ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current=onClose;
  const [style,setStyle] = useState<CSSProperties>();
  const [visible,setVisible] = useState(true);
  useLayoutEffect(()=>{
    if(typeof window==='undefined' || typeof document==='undefined')return;
    const place=()=>{const rect=anchor.current?.getBoundingClientRect();if(rect)setStyle(pickerBounds(rect,{width:window.innerWidth,height:window.innerHeight}));};
    const outside=(event:Event)=>{if(!box.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node))close.current();};
    place(); window.addEventListener?.('resize',place);window.addEventListener?.('scroll',place,true);document.addEventListener?.('pointerdown',outside);
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(place):null;
    const visibility=typeof IntersectionObserver!=='undefined'?new IntersectionObserver(entries=>setVisible(entries[0]?.isIntersecting ?? false)):null;
    if(anchor.current)observer?.observe(anchor.current);
    if(anchor.current)visibility?.observe(anchor.current);
    return ()=>{window.removeEventListener?.('resize',place);window.removeEventListener?.('scroll',place,true);document.removeEventListener?.('pointerdown',outside);observer?.disconnect();visibility?.disconnect();};
  },[anchor]);
  const content=<div ref={box} role="listbox" id={id} aria-label={label} className={className} style={{...style,...(!visible?{display:'none'}:{})}}>{children}</div>;
  return typeof document!=='undefined' && document.body ? createPortal(content,document.body) : content;
}
