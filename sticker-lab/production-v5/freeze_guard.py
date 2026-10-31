#!/usr/bin/env python3
"""Post-copy, final-path proof/media validation before atomic package publication.

All encoders must have completed before invoking this synchronous CLI. It never
repairs stale metadata, waits for an encoder, or treats source-only validation
as final-target validation. A failure leaves no new package manifest.
"""
import argparse,hashlib,json,os,subprocess
from datetime import datetime,timezone
from pathlib import Path


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(path):return json.loads(Path(path).read_text())


def check_files(files):
    assert len({f['path'] for f in files})==len(files),'Duplicate final paths'
    for f in files:
        p=Path(f['path']);assert p.is_file(),str(p)
        assert p.stat().st_size==f['bytes'],f'Final copied byte count changed: {p}'
        assert sha(p)==f['sha256'],f'Final copied SHA mismatch: {p}'


def validate(draft):
    files=draft['files'];check_files(files);by_path={f['path']:f for f in files}
    videos={f['path'] for f in files if Path(f['path']).suffix.lower()=='.mp4'}
    proofs=draft['review_proofs'];assert proofs and videos
    bindings={}
    for proof_path in proofs:
        assert proof_path in by_path
        proof=read(proof_path);records=proof['review_artifacts']
        records=list(records.values()) if isinstance(records,dict) else records
        for r in records:
            path=r['path'];assert path in videos, 'Proof must name an actual final copied MP4 target'
            expected=by_path[path]
            assert r['sha256']==expected['sha256'] and r['bytes']==expected['bytes'],f'Proof/final MP4 binding differs: {path}'
            assert r['frames']==84 and r['duration'] in [2.8,5.6], 'Use84 unique native review frames,30fps or15fps'
            assert path not in bindings;bindings[path]=r
    assert set(bindings)==videos,'Every final copied MP4 requires one exact proof binding'
    actual=[]
    for path,r in bindings.items():
        p=Path(path)
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(p)]))
        assert len(probe['streams'])==1 and probe['streams'][0]['codec_type']=='video'
        assert int(probe['streams'][0]['nb_read_frames'])==r['frames']
        assert abs(float(probe['format']['duration'])-r['duration'])<.001
        # -xerror makes any corrupt-frame decode a failure, not just a warning.
        subprocess.run(['ffmpeg','-nostdin','-v','error','-xerror','-err_detect','explode','-i',str(p),'-map','0:v:0','-f','null','-'],check=True)
        assert p.stat().st_size==r['bytes'] and sha(p)==r['sha256']
        actual.append({'path':path,'sha256':r['sha256'],'bytes':r['bytes'],'frames':r['frames'],'duration':r['duration'],'actual_full_decode':True,'ffprobe':probe})
    # Recheck copied proof/media bytes after all decodes; a late encoder/copy
    # modification invalidates the freeze even if an earlier snapshot passed.
    check_files(files)
    return {'schema_version':1,'id':draft['id'],'at':datetime.now(timezone.utc).isoformat(),
            'actual_final_paths_checked':True,'all_final_file_sha_and_bytes_match':True,
            'all_proof_review_bindings_match':True,'after_decode_files_rechecked':True,
            'videos':actual,'process_completion_required':True,'native_realtime_slow_device_playback':'not_observed',
            'helper_sha256':sha(__file__)}


def main():
    p=argparse.ArgumentParser();p.add_argument('draft',type=Path);p.add_argument('package',type=Path);a=p.parse_args()
    assert not a.package.exists(),'Never rewrite an existing frozen package'
    draft=read(a.draft);report=validate(draft)
    a.package.parent.mkdir(parents=True,exist_ok=True);rp=a.package.with_suffix('.guard.json')
    assert not rp.exists();rp.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    draft['files'].append({'path':str(rp),'sha256':sha(rp),'bytes':rp.stat().st_size})
    draft['files']=sorted(draft['files'],key=lambda f:f['path'])
    draft['files_sha256']=hashlib.sha256(json.dumps(draft['files'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    draft['final_path_guard']={'path':str(rp),'sha256':sha(rp),'passed':True}
    draft['frozen_at']=datetime.now(timezone.utc).isoformat()
    temp=a.package.with_name(a.package.name+'.temporary');temp.write_text(json.dumps(draft,ensure_ascii=False,indent=2)+'\n')
    os.replace(temp,a.package)
    print(json.dumps({'package':str(a.package),'files_sha256':draft['files_sha256'],'final_path_guard':draft['final_path_guard']}))


if __name__=='__main__':main()
