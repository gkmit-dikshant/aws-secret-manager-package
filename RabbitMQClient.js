const amqp = require("amqplib");

/**
 * Client wrapper around amqplib to manage a single RabbitMQ connection
 * with a single channel, queue binding, consumer lifecycle and publishing
 * with confirms.
 *
 * Usage example:
 * const client = new RabbitMQClient({ url, config, logger });
 * await client.connect();
 * await client.consume({ service, sender, db });
 * await client.publishMessage('SERVICE_KEY', payload);
 * await client.close();
 *
 * @class
 */
class RabbitMQClient {
  /**
   * Create a RabbitMQ client instance.
   *
   * @param {object} options
   * @param {string} options.url - RabbitMQ connection URL (amqp://...)
   * @param {object} options.config - RabbitMQ configuration object.
   * @param {string} options.config.EXCHANGE_NAME - Exchange name to use.
   * @param {string} options.config.EXCHANGE_TYPE - Exchange type (e.g. 'direct').
   * @param {string} options.config.QUEUE_NAME - Queue name to assert.
   * @param {string} options.config.ROUTING_KEY - Routing key for binding.
   * @param {object} [options.logger=console] - Logger implementing at least `info`, `warn`, `error`.
   */
  constructor({ url, config, logger }) {
    this.url = url;
    this.config = config;
    this.logger = logger || console;

    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
    this.isShuttingDown = false;
  }

  /**
   * Establish a connection to RabbitMQ and set up the channel, exchange
   * and queue binding defined in the client `config`.
   *
   * This method will set `this.connection`, `this.channel` and
   * `this.queue` on success.
   *
   * @returns {Promise<void>}
   * @throws {Error} If connection or channel creation fails.
   */
  async connect() {
    this.logger.info("Connecting to RabbitMQ...");

    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();

    this.connection.on("error", (err) =>
      this.logger.error("RabbitMQ error", err),
    );

    this.connection.on("close", () => {
      if (!this.isShuttingDown) {
        this.logger.warn("RabbitMQ closed unexpectedly");
      }
    });

    const { EXCHANGE_NAME, EXCHANGE_TYPE, QUEUE_NAME, ROUTING_KEY } =
      this.config;

    await this.channel.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, {
      durable: true,
    });

    const { queue } = await this.channel.assertQueue(QUEUE_NAME, {
      durable: true,
    });

    await this.channel.bindQueue(queue, EXCHANGE_NAME, ROUTING_KEY);
    this.channel.prefetch(1);

    this.queue = queue;
  }

  async consume({ service, sender, db, maxProcessAttemptCount = 3 }) {
    if (!this.channel) {
      await this.connect();
    }

    if (this.consumerTag) {
      this.logger.warn("Consumer already running, skipping");
      return;
    }

    const consumeResult = await this.channel.consume(
      this.queue,
      async (msg) => {
        await this.processMessage(
          { service, msg, sender },
          db,
          maxProcessAttemptCount,
        );
      },
      { noAck: false },
    );

    this.consumerTag = consumeResult.consumerTag;
    this.logger.info(`Consumer started with tag: ${this.consumerTag}`);
  }

  /**
   * Start consuming messages from the configured queue.
   *
   * @param {object} options
   * @param {string} options.service - Name of the service (used in logs).
   * @param {function} options.sender - Async function to send/forward the message. Called as `await sender({ to, message })`.
   * @param {object} options.db - Database instance (expects `db.Notification` and `db.sequelize.transaction()` patterns).
   * @param {number} [options.maxProcessAttemptCount=3] - Maximum processing attempts before marking as permanent failure.
   * @returns {Promise<void>}
   */

  /**
   * Process a single consumed message: validate payload, mark notification
   * records transactional state in the database, invoke the provided
   * `sender` to deliver the notification and update DB status accordingly.
   *
   * This method acknowledges, negatively acknowledges or requeues messages
   * based on processing outcome and DB state.
   *
   * @param {object} provider - Object containing processing dependencies and data.
   * @param {object} provider.service - Service name used for logging.
   * @param {object} provider.msg - The raw AMQP message delivered by RabbitMQ.
   * @param {function} provider.sender - Async sender function called as `await sender({ to, message })`.
   * @param {object} db - Sequelize-style DB object exposing `Notification` model and `sequelize.transaction()`.
   * @param {number} [maxProcessAttemptCount=3] - Max attempts allowed before permanent failure.
   * @returns {Promise<void>} Resolves when processing (and ack/nack) completes.
   */
  async processMessage(
    { service, msg, sender },
    db,
    maxProcessAttemptCount = 3,
  ) {
    const MAX_PROCESSING_ATTEMPTS = maxProcessAttemptCount;
    if (msg === null) {
      this.logger.warn("Consumer received null message, possibly cancelled.");
      return;
    }

    let notificationData;
    let notificationRecord;
    const messageContent = msg.content.toString();

    try {
      // Message content validation
      notificationData = JSON.parse(messageContent);
      const { clientId, messageId, content, destination } = notificationData;

      if (
        !clientId ||
        !messageId ||
        !content ||
        !content.message ||
        !destination
      ) {
        this.logger.error("Invalid message format received from queue", {
          messageId,
          clientId,
        });
        this.channel.nack(msg, false, false);
        return;
      }

      this.logger.info("Received message from RabbitMQ", {
        messageId,
        clientId,
      });
      const transaction = await db.sequelize.transaction();

      try {
        // fetching notification record and attaching lock and transcation
        //TODO must review for undefined notification record
        notificationRecord = await db.Notification.findOne({
          where: { messageId: messageId },
          lock: transaction.LOCK.UPDATE,
          transaction: transaction,
        });

        // no notification found
        if (!notificationRecord) {
          this.logger.error(
            `Notification record not found in DB for messageId: ${messageId}. Discarding message.`,
            { messageId },
          );
          await transaction.commit();
          this.channel.nack(msg, false, false);
          return;
        }
        // already sent notification
        if (notificationRecord.status === "sent") {
          this.logger.warn(
            `Notification already marked as sent. Acknowledging message.`,
            { messageId, dbId: notificationRecord.id },
          );
          await transaction.commit();
          this.channel.ack(msg);
          return;
        }
        // notification already in processing
        if (notificationRecord.status === "processing") {
          this.logger.warn(
            `Notification is already being processed. Acknowledging message.`,
            { messageId, dbId: notificationRecord.id },
          );
          await transaction.commit();
          this.channel.ack(msg);
          return;
        }

        // failed and exceed max processing count
        if (
          notificationRecord.attempts >= MAX_PROCESSING_ATTEMPTS &&
          notificationRecord.status === "failed"
        ) {
          this.logger.error(
            `Notification has reached max processing attempts (${MAX_PROCESSING_ATTEMPTS}). Marking as permanent failure.`,
            { messageId, dbId: notificationRecord.id },
          );
          notificationRecord.status = "failed";
          notificationRecord.connectorResponse =
            (notificationRecord.connectorResponse || "") +
            ` | Max attempts reached.`;
          await notificationRecord.save({ transaction: transaction });
          await transaction.commit();
          this.channel.ack(msg);
          return;
        }

        // update message state to processing
        this.logger.info(`Updating notification status to 'processing'`, {
          messageId,
          dbId: notificationRecord.id,
          attempt: notificationRecord.attempts + 1,
        });
        notificationRecord.status = "processing";
        notificationRecord.attempts += 1;
        await notificationRecord.save({ transaction: transaction });
        await transaction.commit();
      } catch (dbError) {
        this.logger.error("Database error during pre-processing", {
          messageId,
          dbId: notificationData?.dbId,
          error: dbError.message,
          stack: dbError.stack,
        });
        await transaction.rollback();
        this.channel.nack(
          msg,
          false,
          notificationRecord.attempts < MAX_PROCESSING_ATTEMPTS,
        );
        return;
      }

      // process message and sent the notification
      try {
        await sender({ to: destination, message: content.message });
        await db.Notification.update(
          { status: "sent" },
          { where: { id: notificationRecord.id } },
        );
        this.logger.info(`Notification status updated to 'sent'`, {
          messageId,
          dbId: notificationRecord.id,
        });
        this.channel.ack(msg);
      } catch (processingError) {
        this.logger.error(`Error processing ${service}`, {
          messageId,
          dbId: notificationRecord.id,
          error: processingError.message,
          stack: processingError.stack,
        });
        this.logger.error(
          `${service} send failed. Updating status to 'failed'`,
          {
            messageId,
            dbId: notificationRecord.id,
            error: processingError.message,
          },
        );
        await db.Notification.update(
          { status: "failed", connectorResponse: processingError.message },
          { where: { id: notificationRecord.id } },
        );

        this.logger.warn(`Notification status updated to 'failed'`, {
          messageId,
          dbId: notificationRecord.id,
        });
        this.channel.ack(msg);
      }
    } catch (error) {
      this.logger.error("Critical error processing message", {
        error: error.message,
        stack: error.stack,
      });
      this.channel.nack(msg, false, false);
    }
  }

  async publishMessage(serviceType, message) {
    if (!this.channel) {
      await this.connect();
    }

    /**
     * Publish a message to the configured exchange using the routing key
     * matching `serviceType` from the client's `config.services` list.
     * The publish uses persistent delivery mode and waits for confirms.
     *
     * @param {string} serviceType - Service routing key to identify where to publish.
     * @param {object} message - Payload to publish (will be JSON.stringified).
     * @returns {Promise<boolean>} Returns boolean success indicator from channel.publish.
     * @throws {Error} When publishing fails or no matching service config is found.
     */
    try {
      // Find routing key from services config
      const service = this.config.services?.find(
        (s) => s.ROUTING_KEY === serviceType,
      );
      if (!service) {
        throw new Error(`No service found for routing key: ${serviceType}`);
      }

      const success = this.channel.publish(
        this.config.EXCHANGE_NAME,
        service.ROUTING_KEY,
        Buffer.from(JSON.stringify(message)),
        { persistent: true },
      );

      await this.channel.waitForConfirms();
      return success;
    } catch (error) {
      console.log(error);
      throw new Error(
        `Message publishing failed for service [${serviceType}]: ${error.message}`,
      );
    }
  }

  /**
   * Gracefully close consumer, channel, and connection.
   * Marks the client as shutting down to prevent reconnect warnings.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.isShuttingDown = true;

    try {
      if (this.consumerTag) {
        await this.channel.cancel(this.consumerTag);
      }
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
    } finally {
      this.channel = null;
      this.connection = null;
      this.consumerTag = null;
    }

    this.logger.info("RabbitMQ closed cleanly");
  }
}

module.exports = RabbitMQClient;
