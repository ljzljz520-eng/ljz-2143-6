export async function fileTypeFromBuffer(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const hex = buffer.subarray(0,8).toString('hex');
  if (hex.startsWith('ffd8ff')) return { ext:'jpg', mime:'image/jpeg' };
  if (hex.startsWith('89504e47')) return { ext:'png', mime:'image/png' };
  if (buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return { ext:'webp', mime:'image/webp' };
  const text = buffer.subarray(0,512).toString('utf8').trimStart();
  if (text.startsWith('<svg')) return { ext:'svg', mime:'image/svg+xml' };
  if (hex.startsWith('00010000') || hex.startsWith('4f54544f')) return { ext:'ttf', mime:'font/ttf' };
  if (hex.startsWith('774f4646') || hex.startsWith('574f4632')) return { ext:'woff2', mime:'font/woff2' };
  if (text.startsWith('wOFF')) return { ext:'woff', mime:'font/woff' };
  if (hex.startsWith('4f54544f')) return { ext:'otf', mime:'font/otf' };
  return null;
}
