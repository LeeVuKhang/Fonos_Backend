import { PollyClient } from "@aws-sdk/client-polly";
import { S3Client } from "@aws-sdk/client-s3";

export function createAwsClients({ region }) {
  return {
    pollyClient: new PollyClient({ region }),
    s3Client: new S3Client({ region }),
  };
}
