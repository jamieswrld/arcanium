/**
 * Downscale and compress a picked image to a small data URI.
 *
 * The result is embedded in the token's metadata rather than uploaded, so its
 * size is the whole cost: 192px at WebP quality 0.8 keeps a logo legible at
 * every size the site draws it while staying a few kilobytes. WebP also keeps
 * transparency; PNG is the fallback for browsers whose canvas will not encode
 * it, and is chosen by checking the output rather than sniffing the browser.
 */
export async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const max = 192;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const webp = canvas.toDataURL("image/webp", 0.8);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}
