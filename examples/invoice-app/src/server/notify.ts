/** Tells a customer what happened to their invoice. */
export interface Notifier {
  send(to: string): Promise<void>;
}

/** Production notifier: hands the message to the email provider. */
export class EmailNotifier implements Notifier {
  async send(to: string) {
    console.log('email', to);
  }
}

/** The stand-in the unit tests hand in — it sends nothing. */
export class FakeNotifier implements Notifier {
  async send(_to: string) {
    return;
  }
}

/**
 * Tells the customer their invoice was approved.
 * @business Lets the customer know their invoice was approved.
 */
export async function notifyApproved(n: Notifier) {
  await n.send('customer@example.com');
}
