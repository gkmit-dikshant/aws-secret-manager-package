const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
require("dotenv").config();

class SecretManager {
  constructor() {
    this.SECRET_NAME = process.env.AWS_SECRET_NAME;
    this.REGION = process.env.AWS_SECRET_REGION;

    if (!this.SECRET_NAME || !this.REGION) {
      throw new Error("AWS SECRET ERROR: secret name or region is missing!");
    }

    this.CLIENT = new SecretsManagerClient({
      region: this.REGION,
    });
  }

  async getSecrets() {
    try {
      const command = new GetSecretValueCommand({
        SecretId: this.SECRET_NAME,
      });

      const response = await this.CLIENT.send(command);
      const secretString = JSON.parse(response.SecretString);

      let secrets = [];

      for (let key in secretString) {
        secrets.push(JSON.parse(secretString[key]));
      }

      if (secrets.length === 0) {
        throw new Error("No Client Found!");
      }

      return secrets;
    } catch (error) {
      console.error("Error fetching secret:", error);
      throw error;
    }
  }
}

module.exports = { SecretManager: new SecretManager() };
