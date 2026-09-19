import type { OrderConfirmation } from "../../domain/models.js";
import type { NotificationPort } from "../../ports/index.js";

export class HttpNotificationAdapter implements NotificationPort {
  constructor(private readonly baseUrl: string) {}

  async sendConfirmation(message: OrderConfirmation): Promise<void> {
    const response = await fetch(`${this.baseUrl}/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error(`Notification provider returned ${response.status}`);
  }
}
