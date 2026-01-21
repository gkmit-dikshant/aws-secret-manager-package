# AWS Secret Manager Package

A lightweight utility for managing and retrieving AWS Secrets Manager secrets in Node.js applications. This package simplifies access to secrets stored in AWS Secrets Manager for the universal-notifier ecosystem.

## Features

- Easy retrieval of secrets from AWS Secrets Manager
- Environment-based configuration
- Automatic JSON parsing of secrets
- Error handling and validation
- CommonJS module support

## Installation

```bash
npm install @universal-notifier/secret-manager
```

## Prerequisites

- AWS Account with Secrets Manager access
- AWS credentials configured (via IAM role, environment variables, or AWS config file)
- Node.js 14.x or higher
- A secret stored in AWS Secrets Manager

## Setup

### 1. Environment Variables

Create a `.env` file in your project root with the following variables:

```env
AWS_SECRET_NAME=your-secret-name
AWS_SECRET_REGION=us-east-1
```

- `AWS_SECRET_NAME`: The name or ARN of your secret in AWS Secrets Manager
- `AWS_SECRET_REGION`: The AWS region where your secret is stored (e.g., `us-east-1`, `eu-west-1`)

### 2. AWS Credentials

Ensure your AWS credentials are configured. You can:

- Use IAM roles (recommended for production)
- Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables
- Use `~/.aws/credentials` file
- Use AWS SSO

## Usage

### Basic Example

```javascript
const { SecretManager } = require("@universal-notifier/secret-manager");

async function fetchSecrets() {
  try {
    const secrets = await SecretManager.getSecrets();
    console.log(secrets);
  } catch (error) {
    console.error("Failed to fetch secrets:", error.message);
  }
}

fetchSecrets();
```

## Secret Format

Secrets stored in AWS Secrets Manager should follow this structure:

```json
{
  "secret_key_1": "{\"username\": \"user1\", \"password\": \"pass1\"}",
  "secret_key_2": "{\"api_key\": \"key123\", \"api_secret\": \"secret456\"}"
}
```

Each value should be a JSON string that will be automatically parsed by the package.

## API Reference

### `SecretManager.getSecrets()`

Retrieves all secrets from AWS Secrets Manager.

**Returns:** `Promise<Array>` - Array of parsed secret objects

**Throws:**

- Error if secret name or region is not configured
- Error if no secrets are found
- Error if AWS API request fails

**Example:**

```javascript
try {
  const secrets = await SecretManager.getSecrets();
  const firstSecret = secrets[0];
  console.log(firstSecret);
} catch (error) {
  console.error("Failed to get secrets:", error);
}
```

## Error Handling

The package includes built-in error handling:

| Error                                                 | Cause                         | Solution                                                |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| "AWS SECRET ERROR: secret name or region is missing!" | Missing environment variables | Set `AWS_SECRET_NAME` and `AWS_SECRET_REGION` in `.env` |
| "No Client Found!"                                    | Secret contains no data       | Ensure secret has content in AWS Secrets Manager        |
| Network/AWS errors                                    | AWS API connection issues     | Check AWS credentials and region                        |

## Examples

### Initialization Pattern

```javascript
const { SecretManager } = require("@universal-notifier/secret-manager");

let cachedSecrets = null;

async function initializeSecrets() {
  try {
    cachedSecrets = await SecretManager.getSecrets();
    console.log("Secrets loaded successfully");
  } catch (error) {
    console.error("Failed to initialize secrets:", error);
    process.exit(1);
  }
}

module.exports = { initializeSecrets, getSecrets: () => cachedSecrets };
```

## Best Practices

1. **Never commit `.env` files** - Add `.env` to your `.gitignore`
2. **Use IAM roles in production** - Avoid hardcoding credentials
3. **Rotate secrets regularly** - Update secrets in AWS Secrets Manager periodically
4. **Handle errors gracefully** - Always wrap `getSecrets()` in try-catch blocks
5. **Cache secrets** - Consider caching results to reduce API calls
6. **Use appropriate AWS regions** - Ensure the region matches where your secret is stored
7. **Restrict IAM permissions** - Give only `secretsmanager:GetSecretValue` permission to the secret

## Troubleshooting

### "Secret name or region is missing!"

- Verify `.env` file exists in the project root
- Check that `AWS_SECRET_NAME` and `AWS_SECRET_REGION` are set
- Ensure `dotenv` is loading before instantiating SecretManager

### "No Client Found!"

- Verify the secret exists in AWS Secrets Manager
- Check that the secret has content
- Confirm you're using the correct secret name

### Authentication Errors

- Verify AWS credentials are properly configured
- Check IAM permissions include `secretsmanager:GetSecretValue`
- Ensure the region is correct

## License

ISC

## Author

Dikshant Sharma

## Support

For issues or questions, visit: https://github.com/gkmit-dikshant/aws-secret-manager-package
