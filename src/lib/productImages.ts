import { writeFile, unlink, mkdir } from "fs/promises";
import path from "path";

/**
 * Product photos live under public/uploads/products/, served by Next.js's normal
 * static file handling — no custom route needed. In the VPS deploy (see
 * deploy/docker-compose.vps.yml) that path is a named Docker volume, so uploads
 * survive a rebuild instead of being baked into (and lost with) the image.
 */
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "products");
const PUBLIC_PREFIX = "/uploads/products";

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB — a phone photo, not a KB-sized icon
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export class ProductImageError extends Error {}

export async function saveProductImage(productId: string, file: File): Promise<string> {
  if (!file || file.size === 0) throw new ProductImageError("No file provided");
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ProductImageError(`Image is too big (${(file.size / 1_000_000).toFixed(1)}MB) — max 3MB`);
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) throw new ProductImageError("Use a JPEG, PNG, or WebP image");

  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${productId}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(UPLOAD_DIR, filename), bytes);

  // Old file with a different extension (re-uploaded as a different format) would
  // otherwise linger on disk forever, unreferenced by anything.
  for (const otherExt of Object.values(ALLOWED_TYPES)) {
    if (otherExt === ext) continue;
    await unlink(path.join(UPLOAD_DIR, `${productId}.${otherExt}`)).catch(() => {});
  }

  // Cache-bust: same productId+ext filename would otherwise serve a stale
  // browser-cached image after a re-upload.
  return `${PUBLIC_PREFIX}/${filename}?v=${Date.now()}`;
}

export async function deleteProductImage(productId: string): Promise<void> {
  for (const ext of Object.values(ALLOWED_TYPES)) {
    await unlink(path.join(UPLOAD_DIR, `${productId}.${ext}`)).catch(() => {});
  }
}
