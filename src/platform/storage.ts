/**
 * File storage: S3-compatible (AWS S3 / Cloudflare R2 / MinIO in dev).
 * DB stores metadata (files table); objects live under a MANDATORY tenant
 * prefix so a leaked key can't be walked across tenants, and NDPR erasure is
 * a prefix delete.
 */
/**
 * File storage. The AWS SDK is 21MB and Phase 1 does not use it, so it lives in
 * optionalDependencies and is loaded ONLY when a file is actually uploaded.
 * The production image ships without it. Add it back when Documents ships.
 */
import { randomUUID } from "crypto";
import { Tx } from "./db";

async function s3lib() {
  const [c, p] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner"),
  ]).catch(() => { throw new Error("file storage not installed"); });
  return { ...c, getSignedUrl: p.getSignedUrl };
}

const BUCKET = process.env.S3_BUCKET!;
const MAX_BYTES = 25 * 1024 * 1024;

export async function createUpload(
  tx: Tx,
  tenantId: string,
  meta: { filename: string; contentType: string; byteSize: number;
          entityType?: string; entityId?: string; uploadedBy?: string }
) {
  if (meta.byteSize > MAX_BYTES) throw new Error("file_too_large");
  const key = `${tenantId}/${randomUUID()}/${meta.filename.replace(/[^\w.\-]/g, "_")}`;
  const { rows } = await tx.query(
    `INSERT INTO files (tenant_id, storage_key, filename, content_type, byte_size,
                        entity_type, entity_id, uploaded_by)
     VALUES (current_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [key, meta.filename, meta.contentType, meta.byteSize,
     meta.entityType ?? null, meta.entityId ?? null, meta.uploadedBy ?? null]
  );
  const { S3Client, PutObjectCommand, getSignedUrl } = await s3lib();
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: meta.contentType,
                           ContentLength: meta.byteSize }),
    { expiresIn: 600 }
  );
  return { fileId: rows[0].id, uploadUrl };
}

export async function downloadUrl(tx: Tx, fileId: string) {
  // RLS guarantees this row belongs to the current tenant
  const { rows } = await tx.query(
    `SELECT storage_key FROM files WHERE id = $1 AND archived_at IS NULL`, [fileId]);
  if (!rows[0]) throw new Error("not_found");
  const { S3Client, GetObjectCommand, getSignedUrl } = await s3lib();
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
  return getSignedUrl(
    s3, new GetObjectCommand({ Bucket: BUCKET, Key: rows[0].storage_key }),
    { expiresIn: 300 }
  );
}
