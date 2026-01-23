const LRUCache = require("lru-cache");
const RabbitMQClient = require("./RabbitMQClient");

/**
 * Manager that maintains RabbitMQ client instances for multiple
 * client configurations using an LRU cache. It lazily constructs
 * `RabbitMQClient` instances per client ID and keeps them cached
 * for reuse.
 *
 * Example:
 * const mgr = new RabbitMQManager(fetchConfigsCallback, logger);
 * const client = await mgr.getClient('CLIENT_ID');
 * await mgr.close('CLIENT_ID');
 *
 * @class
 */
class RabbitMQManager {
  #logger = console;
  #clientConfigs = [];

  /**
   * Create a manager instance.
   *
   * @param {function} fetchConfigsCallback - Async function that returns an array of client configurations. Each entry should include an `ID` and `RABBITMQ` config.
   * @param {object} [logger=console] - Logger with `info`, `warn`, `error` methods.
   */
  constructor(fetchConfigsCallback, logger) {
    this.fetchConfigsCallback = fetchConfigsCallback;
    if (logger) this.#logger = logger;

    this.cache = new LRUCache({
      max: 50,
      ttl: 1000 * 60 * 60,
      dispose: (value, key) => {
        console.log(
          `Evicting RabbitMQ connection for client ${key} from cache`,
        );
      },
    });
  }

  /**
   * Return (or create) a `RabbitMQClient` for the given `clientId`.
   * If a `clientConfig` is not provided, the manager will attempt to
   * load it via the configured `fetchConfigsCallback`.
   *
   * @param {string} clientId - Identifier for the client configuration.
   * @param {object} [clientConfig] - Optional RabbitMQ configuration object. If omitted, the manager will load it.
   * @returns {Promise<RabbitMQClient>} Connected `RabbitMQClient` instance.
   * @throws {Error} If no configuration can be found for the client.
   */
  async getClient(clientId, clientConfig) {
    if (this.cache.has(clientId)) {
      return this.cache.get(clientId);
    }

    if (!clientConfig) {
      clientConfig = this.#loadClientConfig(clientId);
    }

    if (!clientConfig) {
      throw new Error(`RabbitMQ config not found for client ${clientId}`);
    }

    const url = this.#buildUrl(clientConfig);

    const client = new RabbitMQClient({
      url,
      config: clientConfig,
      logger: this.#logger,
    });
    await client.connect();
    this.cache.set(clientId, client);
    return client;
  }

  /**
   * Load the RabbitMQ configuration for a given client ID.
   * This method first checks the locally cached `#clientConfigs` and
   * falls back to calling `#fetchConfigs()` when necessary.
   *
   * @private
   * @param {string} clientId - Client identifier to look up.
   * @returns {Promise<object>} The `RABBITMQ` configuration object.
   * @throws {Error} When configuration cannot be found.
   */
  async #loadClientConfig(clientId) {
    let clients = this.#clientConfigs;
    let config = clients?.find((c) => c.ID === clientId)?.RABBITMQ;

    if (!config) {
      clients = await this.#fetchConfigs();
      config = clients.find((c) => c.ID === clientId)?.RABBITMQ;
    }

    if (!config) {
      throw new Error(`Failed to load rabbitmq config for client: ${clientId}`);
    }

    return config;
  }

  /**
   * Fetch global client configurations by calling the provided callback.
   * Stores the result in `#clientConfigs` for later lookups.
   *
   * @private
   * @returns {Promise<Array<object>>} Array of client configuration objects.
   * @throws {Error} When no configurations are returned.
   */
  async #fetchConfigs() {
    this.#clientConfigs = await this.fetchConfigsCallback();
    if (!this.#clientConfigs || this.#clientConfigs.length === 0) {
      throw new Error("No client configurations found!");
    }
    return this.#clientConfigs;
  }

  /**
   * Build an AMQP URL string from a `RABBITMQ` configuration object.
   *
   * @private
   * @param {object} config - RabbitMQ config containing `USER`, `PASSWORD`, `HOST`, `PORT`.
   * @returns {string} AMQP connection URL.
   */
  #buildUrl(config) {
    return `amqp://${config.USER}:${config.PASSWORD}@${config.HOST}:${config.PORT}`;
  }

  /**
   * Close and remove the cached `RabbitMQClient` for the provided clientId.
   *
   * @param {string} clientId - Client identifier whose connection should be closed.
   * @returns {Promise<void>}
   */
  async close(clientId) {
    const client = this.cache.get(clientId);
    if (client) {
      await client.close();
      this.cache.delete(clientId);
    }
  }

  /**
   * Close all cached `RabbitMQClient` instances and clear the cache.
   *
   * @returns {Promise<void>}
   */
  async closeAll() {
    for (const [_, client] of this.cache) {
      await client.close();
    }
    this.cache.clear();
  }
}

module.exports = RabbitMQManager;
