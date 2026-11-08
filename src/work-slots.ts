import sharp from 'sharp';
import {checkOperation,operationSignal} from './operations.js';
import {ToolError} from './safe-http.js';
import {sampleMemory,MEMORY_ADMISSION_RATIO,type MemorySnapshot} from './resource-memory.js';

sharp.concurrency(1);sharp.cache({memory:8,files:0,items:16});
const kinds=['other','browser','document_pdf','document_preview','document_read','document_pages','media_segment','media_render','image_decode','image_render','office_inspect','office_edit','compute'] as const;
export type HeavyWorkKind=typeof kinds[number];
type MemoryEvent={event:'runtime_memory';reason:string;kind:HeavyWorkKind|null;active:number;waiting:number;[key:string]:unknown};
interface SlotOptions {
  sample?:()=>Promise<MemorySnapshot>;
  emit?:(event:MemoryEvent)=>void;
  reclaim?:()=>Promise<void>;
  maxWaiting?:number;
  waitTimeoutMs?:number;
}
const MiB=1024*1024;

/** One heavy callback at a time; admission is headroom policy, not an allocation cap. */
export class WorkerSlots {
  private tail:Promise<void>=Promise.resolve();
  private waiting=0;private active=0;private completed=0;private cancelled=0;private denied=0;
  private maxWaitMs=0;private maxProcessRss=0;private kind:HeavyWorkKind|null=null;
  private reclaim?:()=>Promise<void>;
  private sample:()=>Promise<MemorySnapshot>;
  private emit:(event:MemoryEvent)=>void;
  constructor(private options:SlotOptions={}){
    this.sample=options.sample??sampleMemory;this.emit=options.emit??(event=>console.log(JSON.stringify(event)));this.reclaim=options.reclaim;
  }
  setReclaimer(reclaim:()=>Promise<void>){this.reclaim=reclaim;}
  metrics(){return {waiting:this.waiting,active:this.active,completed:this.completed,cancelled:this.cancelled,denied:this.denied,max_queue_wait_ms:this.maxWaitMs,process_peak_rss_bytes:Math.max(this.maxProcessRss,process.memoryUsage().rss),rss_scope:'node_process_only_children_excluded',active_kind:this.kind};}
  private log(reason:string,snapshot:MemorySnapshot,kind=this.kind,extra:Record<string,unknown>={}){
    // Only sampler fields and finite operation labels reach this sink.
    try{this.emit({...snapshot,event:'runtime_memory',reason,kind,active:this.active,waiting:this.waiting,...extra});}catch{/* Diagnostics never change an operation outcome. */}
  }
  async observe(reason='periodic'){
    try{const snapshot=await this.sample();this.log(reason,snapshot);return snapshot;}catch{return undefined;}
  }
  private pressured(snapshot:MemorySnapshot,kind:HeavyWorkKind){
    const reserve=['browser','document_pdf','document_preview'].includes(kind)?192*MiB:128*MiB;
    return snapshot.limit_bytes!==null&&snapshot.current_bytes+reserve>snapshot.limit_bytes*MEMORY_ADMISSION_RATIO;
  }
  async run<T>(fn:()=>Promise<T>,requestedKind:HeavyWorkKind='other'):Promise<T>{
    checkOperation();
    const kind=kinds.includes(requestedKind)?requestedKind:'other',signal=operationSignal();
    if(this.waiting>=(this.options.maxWaiting??8)){this.denied++;throw new ToolError('worker_queue_busy');}
    const entered=Date.now(),prior=this.tail;let release!:()=>void;
    const owned=new Promise<void>(resolve=>{release=resolve;});this.tail=prior.then(()=>owned);
    this.waiting++;let acquired=false,abort:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([prior,new Promise<never>((_,reject)=>{
        abort=()=>reject(signal?.reason??new Error('operation_cancelled'));
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        timer=setTimeout(()=>reject(new ToolError('worker_queue_timeout')),this.options.waitTimeoutMs??30000);
      })]);
      clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);checkOperation();
      this.waiting--;this.active++;acquired=true;this.kind=kind;this.maxWaitMs=Math.max(this.maxWaitMs,Date.now()-entered);
      let snapshot=await this.sample();checkOperation();
      if(this.pressured(snapshot,kind)&&this.reclaim){try{await this.reclaim();}catch{/* A failed cleanup cannot authorize work. */}checkOperation();snapshot=await this.sample();}
      if(this.pressured(snapshot,kind)){this.denied++;this.log('admission_denied',snapshot,kind);throw new ToolError('worker_memory_busy');}
      this.log('heavy_start',snapshot,kind,{admission:snapshot.limit_bytes===null?'limit_unknown':'admitted'});
      let peak=snapshot.current_bytes,sampling=false,finished=false,pressureLogged=false;
      const started=Date.now();this.maxProcessRss=Math.max(this.maxProcessRss,snapshot.node_rss_bytes);
      const sample=setInterval(()=>{
        if(sampling)return;sampling=true;
        void this.sample().then(current=>{
          if(finished)return;peak=Math.max(peak,current.current_bytes);this.maxProcessRss=Math.max(this.maxProcessRss,current.node_rss_bytes);
          if(!pressureLogged&&current.limit_bytes!==null&&current.current_bytes>=current.limit_bytes*MEMORY_ADMISSION_RATIO){pressureLogged=true;this.log('heavy_pressure',current,kind);}
        }).catch(()=>{}).finally(()=>{sampling=false;});
      },1000);sample.unref();
      let ok=false;
      try{checkOperation();const result=await fn();ok=true;return result;}
      finally{
        finished=true;clearInterval(sample);this.completed++;
        try{snapshot=await this.sample();this.log('heavy_end',snapshot,kind,{ok,duration_ms:Date.now()-started,observed_peak_bytes:Math.max(peak,snapshot.current_bytes)});}catch{/* Keep callback outcome. */}
      }
    }finally{
      clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);
      if(acquired){this.active--;this.kind=null;}else{this.waiting--;this.cancelled++;}
      release();
    }
  }
  startTelemetry(intervalMs=30000){
    let stopped=false,busy=false;
    const tick=()=>{if(stopped||busy)return;busy=true;void this.observe().finally(()=>{busy=false;});};
    tick();const timer=setInterval(tick,intervalMs);timer.unref();return ()=>{stopped=true;clearInterval(timer);};
  }
}
const slots=new WorkerSlots();
export function workerMetrics(){return slots.metrics();}
export function withWorkerSlot<T>(fn:()=>Promise<T>,kind:HeavyWorkKind='other'){return slots.run(fn,kind);}
export function setIdleMemoryReclaimer(reclaim:()=>Promise<void>){slots.setReclaimer(reclaim);}
export function startWorkerTelemetry(){return slots.startTelemetry();}

export function isWorkerResourceError(error:unknown):error is ToolError {return error instanceof ToolError&&['worker_memory_busy','worker_queue_busy','worker_queue_timeout','browser_busy'].includes(error.code);}
