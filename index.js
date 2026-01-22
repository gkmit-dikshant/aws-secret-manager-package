const {
  SecretsManagerClient,
  GetSecretValueCommand,
  ListSecretsCommand,
} = require("@aws-sdk/client-secrets-manager");
require("dotenv").config();

class SecretManager {
  constructor() {
    this.NODE_ENV = process.env.NODE_ENV;
    this.isProduction = process.env.NODE_ENV === "production";
    this.REGION = process.env.AWS_SECRET_REGION;
    this.ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
    this.SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

    if (
      !this.isProduction &&
      (!this.ACCESS_KEY_ID || !this.SECRET_ACCESS_KEY)
    ) {
      throw new Error(
        "AWS SECRET ERROR: secret access key or access key id is missing!",
      );
    }

    if (!this.REGION) {
      throw new Error("AWS SECRET ERROR: region is missing!");
    }

    this.CLIENT = new SecretsManagerClient({
      region: this.REGION,
      ...(!this.isProduction && {
        credentials: {
          accessKeyId: this.ACCESS_KEY_ID,
          secretAccessKey: this.SECRET_ACCESS_KEY,
        },
      }),
    });
  }

  async getSecrets(environment = this.NODE_ENV) {
    try {
      const command = new ListSecretsCommand({});
      const { SecretList } = await this.CLIENT.send(command);

      let secrets = [];

      secrets = await Promise.all(
        SecretList.map(async (secret) => {
          const { SecretString } = await this.CLIENT.send(
            new GetSecretValueCommand({ SecretId: secret.Name }),
          );

          if (!SecretString) return null;

          const parsed = JSON.parse(SecretString);
          return JSON.parse(parsed[environment]);
        }),
      );

      if (secrets.length === 0) {
        throw new Error("AWS SECRET ERROR: no secrets found!");
      }

      return secrets;
    } catch (error) {
      console.error("Error fetching secret:", error);
      throw error;
    }
  }

  async getSecret(name, environment = this.NODE_ENV) {
    try {
      if (!name) {
        throw new Error("AWS SECRET ERROR: No name provided!");
      }
      const command = new GetSecretValueCommand({
        SecretId: name,
      });
      const secret = await this.CLIENT.send(command);
      if (!secret) {
        throw new Error(`AWS SECRET ERROR: No Secret Found for ${name}`);
      }
      const parseSecret = JSON.parse(secret.SecretString)[environment];

      if (!parseSecret) {
        throw new Error(
          `AWS SECRET ERROR: No Secret Found for ${name}['${environment}']`,
        );
      }
    } catch (error) {
      console.error("AWS SECRET ERROR: Error fetching secret:", error);
      throw error;
    }
  }
}

module.exports = { SecretManager: new SecretManager() };
