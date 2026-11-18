import "dotenv/config";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  GetBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { s3 } from "../server/services/storage.js";
import { config } from "../server/config.js";
try {
  await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
} catch (e: any) {
  if (e.$metadata?.httpStatusCode !== 404) throw e;
  const region = process.env.S3_REGION || "us-east-1";
  await s3.send(
    new CreateBucketCommand({
      Bucket: config.bucket,
      ...(region !== "us-east-1"
        ? { CreateBucketConfiguration: { LocationConstraint: region as any } }
        : {}),
    }),
  );
}
if (process.env.S3_PROVIDER === "minio") {
  let hasPolicy = false;
  try {
    await s3.send(new GetBucketPolicyCommand({ Bucket: config.bucket }));
    hasPolicy = true;
  } catch (error: any) {
    if (error.name !== "NoSuchBucketPolicy") throw error;
  }
  if (hasPolicy)
    throw new Error(
      "Review the existing MinIO policy: this setup requires a bucket with no anonymous policy.",
    );
} else
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: config.bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
if (process.env.S3_ENCRYPTION !== "none")
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: config.bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    }),
  );
console.info(
  "Private storage initialized. Verify provider-specific encryption and anonymous access restrictions before production.",
);
