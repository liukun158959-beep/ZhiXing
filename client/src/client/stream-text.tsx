import { useRef } from 'react';
import { Markdown } from './Markdown';

// Preserve the prefix; animate only text newly received from actual model events.
export function StreamText({ text, active, externalLinks = false }: { text: string; active: boolean; externalLinks?: boolean }) {
  const previous = useRef({ text: '', start: 0, revision: 0 });
  if (text !== previous.current.text) previous.current = { text, start: text.startsWith(previous.current.text) ? previous.current.text.length : 0, revision: previous.current.revision + 1 };
  return active ? <div className="tebb-stream-text"><span>{text.slice(0, previous.current.start)}</span><span key={previous.current.revision} className="tebb-stream-new">{text.slice(previous.current.start)}</span><i className="tebb-stream-cursor" aria-label="正在输出" /></div> : <Markdown text={text} externalLinks={externalLinks} />;
}
