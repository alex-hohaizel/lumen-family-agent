#!/usr/bin/env python3
"""Inspect original Lottie/TGS without copying its art into Lumen.

Usage: python3 inspect_reference.py source.json [source.tgs ...]
"""
import collections,gzip,json,sys
from pathlib import Path

def inspect(file):
    raw=Path(file).read_bytes();unpacked=gzip.decompress(raw) if raw[:2]==b'\x1f\x8b' else raw
    data=json.loads(unpacked);types=collections.Counter();stats={'keyframes':0,'eased_keyframes':0,'animated_paths':0,'parented_layers':0}
    def walk(x):
        if isinstance(x,dict):
            if isinstance(x.get('ty'),(int,str)):types[str(x['ty'])]+=1
            if 'parent' in x:stats['parented_layers']+=1
            if x.get('a')==1 and isinstance(x.get('k'),list):
                stats['keyframes']+=len(x['k'])
                stats['eased_keyframes']+=sum('i' in k and 'o' in k for k in x['k'] if isinstance(k,dict))
                if any(isinstance(k,dict) and isinstance(k.get('s'),list) and k['s'] and isinstance(k['s'][0],dict) and 'v' in k['s'][0] for k in x['k']):stats['animated_paths']+=1
            for v in x.values():walk(v)
        elif isinstance(x,list):
            for v in x:walk(v)
    walk(data)
    return {'file':Path(file).name,'bytes':len(raw),'json_bytes':len(unpacked),'gzip_bytes':len(gzip.compress(unpacked)),'fps':data['fr'],'size':[data['w'],data['h']],'frames':data['op']-data['ip'],'seconds':round((data['op']-data['ip'])/data['fr'],4),'root_layers':len(data['layers']),'total_layers':sum(types[str(x)] for x in [0,1,2,3,4,5]),'shape_types':dict(types),**stats}

if __name__=='__main__':print(json.dumps([inspect(x) for x in sys.argv[1:]],ensure_ascii=False,indent=2))
