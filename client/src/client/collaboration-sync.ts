import type { DemoState } from './chat-prototype-state';
import { rpc, type BackendInfo } from './api';
export type CollaborationUpdate = {state?:DemoState;sync?:string;patch?:{base:string;values:Partial<DemoState>;collections:Record<string,{upsert:{id:string}[];order:string[]}>}};
const legacy = new Set<string>();
export async function loadCollaboration(info:BackendInfo,since:string) {
  const key=`${info.port}:${info.scope || ''}`;
  try{return await rpc<CollaborationUpdate>(info,'load_collaboration',legacy.has(key)?{}:{since},{timeoutMs:12000});}
  catch(error){
    // A source hot reload may precede a Python restart. Keep the old backend usable.
    if(!String(error).includes('unexpected keyword') || !String(error).includes('since'))throw error;
    legacy.add(key);return rpc<CollaborationUpdate>(info,'load_collaboration',{}, {timeoutMs:12000});
  }
}

export class CollaborationSync {
  state:DemoState | null = null;
  sync = '';
  snapshot(state:DemoState, sync='') {
    if (this.state && (state.revision || 0) < (this.state.revision || 0)) return null;
    this.state=state;this.sync=sync;return state;
  }
  update(reply:CollaborationUpdate) {
    if (reply.state) return this.snapshot(reply.state,reply.sync);
    if (!this.state || !reply.patch || reply.patch.base!==this.sync) return null;
    const next={...this.state,...reply.patch.values};
    for(const [key,collection] of Object.entries(reply.patch.collections)) {
      const rows=new Map(((this.state as unknown as Record<string,{id:string}[]>)[key] || []).map(row=>[row.id,row]));
      for(const row of collection.upsert)rows.set(row.id,row);
      const ordered=collection.order.map(id=>rows.get(id));
      if(ordered.some(row=>!row)){this.sync='';return null;}
      (next as unknown as Record<string,unknown>)[key]=ordered;
    }
    return this.snapshot(next,reply.sync);
  }
}
