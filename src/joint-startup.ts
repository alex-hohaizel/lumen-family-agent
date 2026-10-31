import {createHash} from 'node:crypto';
import {ensureStickerPack,stickerAssets,STICKER_COUNT,STICKER_SET,type LumenPack,type StickerAsset} from './sticker-pack.js';
import type {Telegram} from './telegram.js';

// Approved 1.13 repertoire, in display order. A previous 120-item manifest
// cannot satisfy the joint release merely by having the same item count.
export const JOINT_STICKER_RELEASE='1.13.1';
export const JOINT_STICKER_FINGERPRINT='0c30bf0ae640f49e30caa02b3d7dd7656e43ca330514e1bbfd2783ea8513afe9';
export function stickerReleaseFingerprint(assets:ReadonlyArray<Pick<StickerAsset,'id'|'sha256'>>){
  return createHash('sha256').update(JSON.stringify(assets.map(asset=>[asset.id,asset.sha256]))).digest('hex');
}
export function assertJointStickerAssets(assets:ReadonlyArray<Pick<StickerAsset,'id'|'sha256'>>){
  if(assets.length!==STICKER_COUNT||stickerReleaseFingerprint(assets)!==JOINT_STICKER_FINGERPRINT)throw Error('joint_sticker_assets_unapproved');
}

interface StickerStartup {
  telegram:Telegram;ownerId?:string|null;runtimeDir?:string;requireVerified:boolean;paceMs?:number;
  ready?:(pack:LumenPack)=>void;failed?:(error:unknown)=>void;
}
/** Activation owns router initialization; callers await it before starting any
 * ingress/poller/worker. Telegram publication remains incremental. Only the final
 * full readback from ensureStickerPack permits required-mode activation.
 */
export async function activateWithStickerPack<T>(options:StickerStartup,activate:(pack:LumenPack|undefined)=>Promise<T>):Promise<T>{
  if(options.requireVerified&&!/^[1-9]\d*$/.test(options.ownerId||''))throw Error('joint_sticker_owner_required');
  let pack:LumenPack|undefined;
  if(options.ownerId)try{
    if(options.requireVerified)assertJointStickerAssets(await stickerAssets());
    pack=await ensureStickerPack(options.telegram,options.ownerId,options.runtimeDir,options.paceMs);
    if(options.requireVerified&&(pack.name.toLowerCase()!==STICKER_SET.toLowerCase()||pack.stickers.length!==STICKER_COUNT))throw Error('joint_sticker_pack_unverified');
    options.ready?.(pack);
  }catch(error){
    options.failed?.(error);
    if(options.requireVerified)throw error;
  }
  // A runtime failure is not a sticker failure and must never retry activation.
  return activate(pack);
}
