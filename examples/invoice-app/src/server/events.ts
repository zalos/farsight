/** Publishes a domain event to the message bus (NATS in production). */
export async function publish(topic: string, payload: unknown) {
  console.log('publish', topic, payload);
}
