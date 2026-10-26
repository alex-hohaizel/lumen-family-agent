import type { Config } from './config.js';
import { ModelError } from './auth.js';
export class Media {
  constructor(private config:Config,private fetcher:typeof fetch=fetch){}
  async transcribe(bytes:Uint8Array,mime='audio/ogg') {
    if(!this.config.apiKey || !this.config.transcribeModel)throw new ModelError('voice_not_configured');
    const form=new FormData();form.set('model',this.config.transcribeModel);
    form.set('file',new Blob([bytes as BlobPart],{type:mime}),'voice.ogg');
    let res;
    try{res=await this.fetcher('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`},body:form,signal:AbortSignal.timeout(90000)});}
    catch{throw new ModelError('voice_network');}
    if(!res.ok)throw new ModelError(`voice_http_${res.status}`);
    const json:any=await res.json();if(typeof json.text!=='string')throw new ModelError('voice_invalid_result');
    return json.text.slice(0,12000);
  }
  async image(prompt:string,references:string[]=[],signal?:AbortSignal) {
    if(!this.config.apiKey || !this.config.imageModel)throw new ModelError('image_not_configured');
    let res;
    try{
      const abort=signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000);
      if(references.length){
        const form=new FormData();form.set('model',this.config.imageModel);form.set('prompt',prompt);form.set('size','1024x1024');form.set('n','1');
        for(let i=0;i<references.length;i++){const ref=references[i]!;if(!/^data:image\/(jpeg|png|webp);base64,/.test(ref))throw new ModelError('image_reference_invalid');form.append('image[]',new Blob([Buffer.from(ref.split(',')[1]!,'base64')],{type:ref.slice(5,ref.indexOf(';'))}),`reference-${i}.jpg`);}
        res=await this.fetcher('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`},body:form,signal:abort});
      }else res=await this.fetcher('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.config.imageModel,prompt,n:1,size:'1024x1024'}),signal:abort});
    }
    catch{throw new ModelError('image_network');}
    if(!res.ok)throw new ModelError(`image_http_${res.status}`);
    const json:any=await res.json();
    // Do not fetch arbitrary URLs returned by an external model.
    const data=json.data?.[0]?.b64_json;if(typeof data!=='string' || data.length>20*1024*1024)throw new ModelError('image_invalid_result');
    return Buffer.from(data,'base64');
  }
}
