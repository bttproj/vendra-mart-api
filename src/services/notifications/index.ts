import { InAppChannel, pickEmailChannel } from "./channels.js";
import { NotificationService } from "./NotificationService.js";

let override: NotificationService | undefined;
let cached: NotificationService | undefined;

/** Tests swap in their own channels. */
export function setNotifier(service: NotificationService | undefined) {
  override = service;
}

export function getNotifier(): NotificationService {
  return override ?? (cached ??= new NotificationService([new InAppChannel(), pickEmailChannel()]));
}

export { NotificationService } from "./NotificationService.js";
export type { NotificationChannel, NotificationMessage, NotifyOptions, Recipient, SendReport } from "./NotificationService.js";
