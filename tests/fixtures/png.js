/** A tiny buffer that starts with the PNG signature, for upload tests. */
export const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
