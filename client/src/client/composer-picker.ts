export type ComposerTrigger = { kind: 'members' | 'skills'; query: string; start: number; end: number };
export function composerTrigger(text: string, cursor: number): ComposerTrigger | null {
  const prefix = text.slice(0,cursor);
  if ((prefix.match(/```/g)?.length || 0) % 2) return null;
  const match = /(?:^|\s)([@/])([^\s@/]*)$/.exec(prefix);
  if (!match) return null;
  return { kind: match[1] === '@' ? 'members' : 'skills', query: match[2], start: cursor-match[2].length-1, end: cursor };
}
export function applyComposerChoice(text: string, trigger: ComposerTrigger, name: string) {
  const inserted = trigger.kind === 'members' ? '@'+name+' ' : '';
  return { text: text.slice(0,trigger.start)+inserted+text.slice(trigger.end), cursor: trigger.start+inserted.length };
}
