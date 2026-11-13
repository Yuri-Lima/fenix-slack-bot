/** Tiny buffers that start like real media files, for upload tests. */

/** The PNG signature. */
export const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
/** An MP4: an 'ftyp' box with the isom brand. */
export const MP4 = Buffer.concat([
  Buffer.from('\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2mp41', 'latin1'),
  Buffer.alloc(64, 2),
]);
/** A WebM: an EBML header whose DocType is "webm". */
export const WEBM = Buffer.concat([
  Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d', 'hex'),
  Buffer.alloc(64, 3),
]);
