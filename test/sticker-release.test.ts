import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stickerAssets} from '../src/sticker-pack.js';
import {JOINT_STICKER_RELEASE,JOINT_STICKER_FINGERPRINT,stickerReleaseFingerprint} from '../src/joint-startup.js';

test('release contains exactly the approved 120 video/preview pairs and ordinary manifest',async()=>{
  const release=JSON.parse(await readFile(new URL('../../test/fixtures/sticker-release-1131.json',import.meta.url),'utf8'));
  const assets=await stickerAssets();
  assert.equal(JOINT_STICKER_RELEASE,release.release);
  assert.equal(JOINT_STICKER_FINGERPRINT,release.ordered_fingerprint);
  assert.equal(stickerReleaseFingerprint(assets),release.ordered_fingerprint);
  assert.equal(assets.length,120);
  assert.deepEqual(assets.map(asset=>asset.id),release.ordered_ids);
  const expected=['manifest.json'];
  for(const asset of assets){
    for(const [field,hashField] of [['file','sha256'],['preview','preview_sha256']] as const){
      const entry=asset as unknown as Record<string,string>;
      const path=entry[field]!;
      assert.match(path,/^lumen_\d+\.(webm|png)$/);
      const bytes=await readFile(new URL('../../assets/stickers/'+path,import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),entry[hashField],asset.id+':'+field);
      expected.push(path);
    }
  }
  assert.deepEqual((await readdir(new URL('../../assets/stickers/',import.meta.url))).sort(),expected.sort());
  assert.equal(release.repairs.length,35);
  for(const repair of release.repairs){
    const asset=assets.find(item=>item.id===repair.id)!;
    assert.ok(asset,repair.id);
    assert.notEqual(repair.before_sha256,repair.after_sha256);
    assert.equal(asset.sha256,repair.after_sha256);
    assert.equal(asset.bytes,repair.after_bytes);
    assert.equal((asset as unknown as Record<string,string>).preview_sha256,repair.after_preview_sha256);
  }
});
