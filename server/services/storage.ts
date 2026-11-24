import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";
export const s3 = new S3Client({
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials:
    !process.env.AWS_ACCESS_KEY_ID && process.env.S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
        }
      : undefined,
});
export const storage = {
  async put(key: string, body: Buffer, mime: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: mime,
        ServerSideEncryption:
          process.env.S3_ENCRYPTION === "none" && !config.production
            ? undefined
            : "AES256",
      }),
    );
  },
  async read(key: string) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    return Buffer.from(await object.Body!.transformToByteArray());
  },
  async open(key: string, signal?: AbortSignal) {
    return s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
      abortSignal: signal,
    });
  },
  async remove(key: string) {
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  },
  async url(key: string) {
    return getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentDisposition: "inline",
      }),
      { expiresIn: 120 },
    );
  },
};
