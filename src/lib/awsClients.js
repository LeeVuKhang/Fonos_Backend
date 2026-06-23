import { PollyClient } from "@aws-sdk/client-polly";

export function createAwsClients({ region }) {
  return {
    pollyClient: new PollyClient({ region }),
  };
}
