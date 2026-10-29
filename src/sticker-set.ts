// Published releases get distinct short names: clients can retain old sets by
// both short name and Telegram ID. Keep the legacy set intact for its users.
export const LEGACY_STICKER_SET='Lumen_Moods_by_lumen_family_agent';
export const STICKER_SET='Lumen_50_v18_by_lumen_family_agent';
export const STICKER_TITLE='Люмен — 50 емоцій';
export const STICKER_CHECKPOINT_FILE=`sticker-pack-${STICKER_SET.toLowerCase()}.json`;
export function stickerSetURL(){return 'https://t.me/addstickers/'+STICKER_SET;}
