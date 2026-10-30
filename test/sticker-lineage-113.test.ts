import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';

const root=new URL('../../',import.meta.url);
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
async function pinned(path:string,expected?:string){
 assert.equal(typeof path,'string');assert.ok(!path.startsWith('/')&&!path.split('/').includes('..'));
 const bytes=await readFile(new URL(path,root));
 if(expected){assert.match(expected,/^[a-f0-9]{64}$/);assert.equal(sha(bytes),expected,path);}
 return bytes;
}

// Components have their own exact crop dimensions; they are not recovered
// animation keyposes or 512px corrected anchors.
async function generatedLayers(source:any,repair:any,asset:any){
 assert.equal(source.not_recovered_original_art,true);
 assert.equal(source.not_original_keyposes,true);
 assert.equal(source.baseline_video_sha256,repair.previous_output_sha256);
 assert.ok(source.baseline_video_path.startsWith('sticker-lab/production-v5/approved-sources/'));
 await pinned(source.baseline_video_path,source.baseline_video_sha256);
 assert.ok(source.baseline_frames.length>0);
 for(const frame of source.baseline_frames){
  assert.equal(frame.kind,'decoded_baseline_video_frame');
  assert.ok(Number.isInteger(frame.frame_index)&&frame.frame_index>=0&&frame.frame_index<84);
  assert.ok(Math.abs(frame.timestamp_seconds-frame.frame_index/30)<1e-8);
  await pinned(frame.path,frame.sha256);
 }
 const generation=source.generation;
 assert.equal(generation.tool,'built-in image_gen.imagegen');
 assert.ok(generation.actual_agent_id);
 assert.equal(generation.operation,'layer_component_generation_and_targeted_source_edits');
 assert.equal(generation.literal_prompts_preserved,true);
 const metadata=JSON.parse((await pinned(generation.metadata_path,generation.metadata_sha256)).toString());
 assert.equal(metadata.actual_agent_id,generation.actual_agent_id);
 assert.equal(metadata.operations.length,generation.operation_chain_count);
 assert.ok(metadata.operations.length>0);
 const inputs=new Map<string,Buffer>();
 for(const input of generation.input_references){
  assert.ok(input.path.startsWith('sticker-lab/production-v5/approved-sources/'));
  inputs.set(input.sha256,await pinned(input.path,input.sha256));
 }
 const raws=new Map<string,{bytes:Buffer,size:[number,number]}>();
 for(const raw of generation.raw_outputs){
  assert.ok(raw.path.startsWith('sticker-lab/production-v5/approved-sources/'));
  const bytes=await pinned(raw.path,raw.sha256);
  assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],raw.size);
  assert.equal(raw.size.length,2);
  assert.equal(bytes[25],6,'Generated layer source must preserve RGBA transparency');
  assert.ok(raw.actual_tool_returned_path);
  assert.equal(raws.has(raw.sha256),false);
  raws.set(raw.sha256,{bytes,size:raw.size});
 }
 assert.equal(raws.size,metadata.operations.length);
 for(const operation of metadata.operations){
  assert.equal(operation.tool,'built-in image_gen.imagegen');
  assert.equal(operation.actual_agent_id,generation.actual_agent_id);
  assert.equal(operation.transparent_background,true);
  assert.equal(typeof operation.prompt,'string');assert.ok(operation.prompt.trim().length>30);
  const output=raws.get(operation.output_sha256);assert.ok(output,'Missing exact tool output');
  assert.deepEqual(operation.output_size,output.size);
  assert.equal(operation.output_mode,'RGBA');
  assert.ok(operation.inputs.length>0);
  for(const input of operation.inputs){
   assert.ok(input.actual_tool_input_path&&input.archived_path&&input.role);
   assert.ok(inputs.has(input.sha256),'Missing preserved actual operation input');
  }
 }
 const anchors=[...source.anchors].sort((a:any,b:any)=>a.key.localeCompare(b.key));
 assert.ok(anchors.length>0);assert.equal(new Set(anchors.map((a:any)=>a.key)).size,anchors.length);
 for(const anchor of anchors){
  assert.equal(anchor.origin,'generated_layer_components');
  assert.equal(anchor.original_video_timestamp,null);
  assert.equal('index' in anchor,false);assert.equal('timestamp_seconds' in anchor,false);
  assert.ok(anchor.path.startsWith('sticker-lab/production-v5/approved-sources/'));
  const bytes=await pinned(anchor.path,anchor.sha256);
  const derivation=anchor.derivation,raw=raws.get(derivation.raw_output_sha256);assert.ok(raw);
  const [left,top,right,bottom]=derivation.crop_box_xyxy;
  assert.ok([left,top,right,bottom].every(Number.isInteger));
  assert.ok(left>=0&&top>=0&&right>left&&bottom>top&&right<=raw.size[0]&&bottom<=raw.size[1]);
  assert.deepEqual([right-left,bottom-top],[anchor.width,anchor.height]);
  assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[anchor.width,anchor.height]);
  assert.equal(derivation.resize,null);assert.equal(derivation.padding,null);
  const cropped=await sharp(raw.bytes).extract({left,top,width:right-left,height:bottom-top}).ensureAlpha().raw().toBuffer();
  const actual=await sharp(bytes).ensureAlpha().raw().toBuffer();
  assert.equal(sha(actual),sha(cropped),'Component pixels must be the declared exact rectangular crop');
 }
 const bundle=sha(anchors.map((anchor:any)=>anchor.sha256).join(''));
 assert.equal(bundle,source.generated_source_bundle_sha256);assert.equal(bundle,asset.source_keyposes_sha256);
}

test('виправлені відеостікери мають точне походження кадрів і незалежно прийняті незмінні байти',async()=>{
 const assets=JSON.parse((await pinned('assets/stickers/manifest.json')).toString()) as any[];
 for(const asset of assets.filter(a=>a.motion_version===5)){
  const source=asset.source_provenance,repair=asset.repair_provenance;
  assert.equal(source.ancestor_original_keyposes_sha256,asset.previous_source_keyposes_sha256);
  assert.notEqual(asset.source_keyposes_sha256,asset.previous_source_keyposes_sha256);
  if(source.kind==='derived_decoded_video'){
   assert.equal(source.source_video_sha256,repair.previous_output_sha256);
   assert.ok(source.source_video_path.startsWith('sticker-lab/production-v5/approved-sources/'));
   await pinned(source.source_video_path,source.source_video_sha256);
   const frames=[...source.frames].sort((a:any,b:any)=>a.index-b.index);
   assert.ok(frames.length>0);assert.equal(new Set(frames.map((f:any)=>f.index)).size,frames.length);
   for(const frame of frames){
    assert.ok(Number.isInteger(frame.index)&&frame.index>=0&&frame.index<84);
    assert.ok(Math.abs(frame.timestamp_seconds-frame.index/30)<1e-8);
    assert.ok(frame.path.startsWith('sticker-lab/production-v5/approved-sources/'));
    await pinned(frame.path,frame.sha256);
   }
   const bundle=sha(frames.map((f:any)=>f.sha256).join(''));
   assert.equal(bundle,source.derived_source_bundle_sha256);assert.equal(bundle,asset.source_keyposes_sha256);
  }else if(source.kind==='generated_layer_components'){
   await generatedLayers(source,repair,asset);
   for(const corrupt of [
    (copy:any)=>copy.generation.raw_outputs[0].size[0]++,
    (copy:any)=>copy.generation.input_references=[],
    (copy:any)=>copy.anchors[0].derivation.crop_box_xyxy[2]++,
    (copy:any)=>copy.anchors[0].original_video_timestamp=0
   ]){
    const copy=structuredClone(source);corrupt(copy);
    await assert.rejects(()=>generatedLayers(copy,repair,asset),'Invented layer lineage must be rejected');
   }
  }else{
   assert.equal(source.kind,'generated_corrected_anchor');
   assert.equal(source.not_recovered_original_art,true);
   assert.equal(source.baseline_video_sha256,repair.previous_output_sha256);
   await pinned(source.baseline_video_path,source.baseline_video_sha256);
   const target=source.baseline_target,identity=source.identity_reference,generation=source.generation;
   assert.equal(target.source_kind,'decoded_baseline_video_frame');
   assert.ok(Number.isInteger(target.frame_index)&&target.frame_index>=0&&target.frame_index<84);
   assert.ok(Math.abs(target.timestamp_seconds-target.frame_index/30)<1e-8);
   await pinned(target.path,target.sha256);await pinned(identity.path,identity.sha256);
   assert.equal(generation.tool,'built-in image_gen.imagegen');assert.ok(generation.actual_agent);
   assert.equal(generation.operation,'precise-object-edit');
   const metadata=JSON.parse((await pinned(generation.metadata_path,generation.metadata_sha256)).toString());
   assert.ok(metadata.prompt&&metadata.transparent_background);
   assert.equal(metadata.generated_sha256,generation.original_image_sha256);
   assert.equal(metadata.anchor_sha256,generation.animation_anchor_sha256);
   for(const [role,expected] of [['edit_target',target.sha256],['identity_reference',identity.sha256]]){
    assert.equal(metadata.actual_input_references.find((input:any)=>input.role===role)?.sha256,expected);
   }
   const original=await pinned(generation.original_image_path,generation.original_image_sha256);
   const anchor=await pinned(generation.animation_anchor_path,generation.animation_anchor_sha256);
   assert.deepEqual([original.readUInt32BE(16),original.readUInt32BE(20)],generation.original_image_size);
   assert.deepEqual([anchor.readUInt32BE(16),anchor.readUInt32BE(20)],[512,512]);
   assert.equal(anchor[25],6,'Generated anchor must preserve RGBA transparency');
   assert.equal(generation.generated_anchor_has_no_original_video_timestamp,true);
   const anchors=[...source.anchors].sort((a:any,b:any)=>a.key.localeCompare(b.key));
   assert.ok(anchors.length>0);assert.equal(new Set(anchors.map((a:any)=>a.key)).size,anchors.length);
   for(const input of anchors){
    assert.equal(input.origin,'generated_corrected_anchor');assert.equal(input.original_video_timestamp,null);
    assert.equal('index' in input,false);assert.equal('timestamp_seconds' in input,false);
    await pinned(input.path,input.sha256);
   }
   const bundle=sha(anchors.map((input:any)=>input.sha256).join(''));
   assert.equal(bundle,source.generated_source_bundle_sha256);assert.equal(bundle,asset.source_keyposes_sha256);
  }
  assert.ok(repair.proof_path.startsWith('sticker-lab/production-v5/approved-proofs/'));
  await pinned(repair.proof_path,repair.proof_sha256);
  await pinned(repair.recipe_path,repair.recipe_sha256);
  for(const [path,hash] of [['engine_path','engine_sha256'],['support_path','support_sha256'],['original_generator_snapshot','original_generator_sha256'],['original_support_snapshot','original_support_sha256']]){
   await pinned(repair.generator[path!],repair.generator[hash!]);
  }
  const rerender=repair.reproducibility;
  await pinned(rerender.artifact,rerender.artifact_sha256);
  assert.equal(rerender.raw_rgba_exact_match,true);assert.equal(rerender.encoded_frame_exact_match,true);assert.equal(rerender.canonical_video_read,false);
  const approvals=JSON.parse((await pinned(repair.approved_record)).toString());
  const approved=approvals.items.find((item:any)=>item.id===asset.id);
  assert.ok(approved,asset.id);assert.equal(approved.candidate_id,repair.candidate_id);
  assert.equal(approved.output_sha256,asset.sha256);assert.equal(approved.output_bytes,asset.bytes);
  assert.equal(approved.poster_sha256,asset.preview_sha256);assert.equal(approved.proof_sha256,repair.proof_sha256);
  assert.equal(approved.description_uk,asset.description);assert.equal(repair.qa.verdict,'accept');
  assert.ok(repair.qa.actual_agent_id&&repair.qa.review_id&&repair.qa.accepted_scope&&repair.qa.limitations);
  await pinned(repair.qa.artifact,repair.qa.artifact_sha256);
  await pinned('assets/stickers/'+asset.file,asset.sha256);await pinned('assets/stickers/'+asset.preview,asset.preview_sha256);
 }
});
