import type {TextEntity} from './telegram.js';
export interface TextDocument {text:string;entities:TextEntity[];}
export function validEntities(text:string,candidates:TextEntity[]){
 const valid:TextEntity[]=[];
 for(const e of [...candidates].sort((a,b)=>Number(['code','pre'].includes(b.type))-Number(['code','pre'].includes(a.type))||a.offset-b.offset||b.length-a.length)){
  if(!Number.isInteger(e.offset)||!Number.isInteger(e.length)||e.offset<0||e.length<1||e.offset+e.length>text.length)continue;
  if(valid.some(v=>{const end=e.offset+e.length,ve=v.offset+v.length,overlap=e.offset<ve&&v.offset<end;if(!overlap)return false;if(e.type===v.type&&e.offset===v.offset&&e.length===v.length)return true;if(['code','pre'].includes(e.type)||['code','pre'].includes(v.type)||e.type==='text_link'&&v.type==='text_link'||e.type.includes('blockquote')&&v.type.includes('blockquote'))return true;return !(e.offset>=v.offset&&end<=ve||v.offset>=e.offset&&ve<=end);}))continue;
  valid.push(e);
 }
 return valid.sort((a,b)=>a.offset-b.offset||b.length-a.length);
}
export function formatText(input:string):TextDocument{
 let text='',pos=0;const entities:TextEntity[]=[];
 const tokens=/```(?:[A-Za-z0-9_+-]+\n)?(?<pre>[\s\S]*?)```|`(?<code>[^`\n]+)`|\*\*(?<bold>[^*\n]+)\*\*|^#{1,3}\s+(?<heading>[^\n]+)/gm;
 for(const match of input.matchAll(tokens)){text+=input.slice(pos,match.index);const g=match.groups!,type=g.pre!==undefined?'pre':g.code!==undefined?'code':'bold',value=g.pre??g.code??g.bold??g.heading??'';if(value)entities.push({type,offset:text.length,length:value.length});text+=value;pos=match.index!+match[0].length;}
 text+=input.slice(pos);return {text,entities:validEntities(text,entities)};
}
export function removeEmoji(text:string){return [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(p=>/^[0-9#*]\ufe0f?\u20e3$/u.test(p.segment)?p.segment.replace(/[\ufe0f\u20e3]/g,''):/[\p{Extended_Pictographic}\u20e3\p{Regional_Indicator}]/u.test(p.segment)?'':p.segment).join('');}
export function remapEntities(original:string,translated:string,entities:TextEntity[]=[]){
 const out:TextEntity[]=[];for(const e of entities){const span=original.slice(e.offset,e.offset+e.length),index=translated.indexOf(span);if(index>=0&&translated.indexOf(span,index+1)<0)out.push({...e,offset:index});}
 return validEntities(translated,out);
}
