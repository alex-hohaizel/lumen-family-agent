from pathlib import Path
import subprocess,json,time
repo=Path(__file__).resolve().parents[1]
started=time.monotonic()
proc=subprocess.Popen(['node','scripts/resource-pilot.mjs'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
peak=0;samples=0;max_children=0;resolved_root=None
self_host=int(dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)['Pid'])
while proc.poll() is None:
 rows={}
 for p in Path('/proc').glob('[0-9]*/status'):
  try:
   d=dict(line.split(':',1) for line in p.read_text().splitlines() if ':' in line);rows[int(p.parent.name)]=(int(d['PPid']),int(d.get('VmRSS','0 kB').split()[0])*1024)
   if int(d['PPid'])==self_host and int(d.get('NSpid',d['Pid']).split()[-1])==proc.pid:resolved_root=int(p.parent.name)
  except (OSError,ValueError,KeyError):pass
 tree={resolved_root} if resolved_root is not None else set()
 for _ in range(20):
  old=len(tree);tree.update(pid for pid,(parent,rss) in rows.items() if parent in tree)
  if len(tree)==old:break
 peak=max(peak,sum(rows.get(pid,(0,0))[1] for pid in tree));max_children=max(max_children,len(tree)-1);samples+=1;time.sleep(.05)
stdout,stderr=proc.communicate()
if proc.returncode:print(stderr.decode()[-2000:]);raise SystemExit(proc.returncode)
result=json.loads(stdout);result.update({'scope':'Local Node24 real DOCX->Chromium PDF, 3200x2400 photo decode and H264 encoding queued together; no PGlite or model requests','combined_peak_rss_bytes':peak,'maximum_children':max_children,'samples':samples,'sample_interval_ms':50,'memory_limit_enforced':False,'cpu_quota_enforced':False,'production_certification':False,'process_tree_mapped':resolved_root is not None,'elapsed_ms':round((time.monotonic()-started)*1000),'rss_sum_shared_pages_may_repeat':True})
assert resolved_root is not None and peak>0,'RSS sampling unavailable; do not report zero as a measured peak'
(repo/'docs/qa-1-12/resource-pilot.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result))
