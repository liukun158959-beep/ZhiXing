import { useRef } from 'react';
import { Markdown } from './Markdown';

// Preserve the prefix; animate only text newly received from actual model events.
export function StreamText({ text, active, externalLinks = false }: { text: string; active: boolean; externalLinks?: boolean }) {
  const previous = useRef({ text: '', start: 0, revision: 0 });
  if (text !== previous.current.text) previous.current = { text, start: text.startsWith(previous.current.text) ? previous.current.text.length : 0, revision: previous.current.revision + 1 };
  return <div className={active ? 'tebb-stream-text' : undefined}><Markdown text={text} externalLinks={externalLinks} reveal={active ? { from: previous.current.start, revision: previous.current.revision } : undefined} />{active && <i className="tebb-stream-cursor" aria-label="正在输出" />}</div>;
}
