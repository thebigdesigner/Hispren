/**
 * Provider abstraction. You WILL switch providers — on price, on a bad delivery
 * week, on an outage during a Sunday service. Never integrate one directly.
 */
export type SendResult = {
  ok: boolean;
  providerId?: string;
  cost?: number;
  balance?: number;
  error?: string;
};

export type Route = "generic" | "dnd";

export interface SmsProvider {
  name: string;
  send(to: string, from: string, body: string, route: Route): Promise<SendResult>;
  /** Is this number on the national Do-Not-Disturb register? */
  checkDnd?(phone: string): Promise<{ isDnd: boolean; network?: string }>;
  senderIds?(): Promise<Array<{ sender_id: string; status: string }>>;
}

import { TermiiProvider } from "./termii";
import { DryRunProvider } from "./dryrun";

export function provider(): SmsProvider {
  // No API key -> DRY RUN. Every message is written to the database and shown
  // in the UI, and nothing leaves the building. A church can be demoed, and the
  // whole suppression layer exercised, before a single sender ID is approved.
  if (!process.env.TERMII_API_KEY) return new DryRunProvider();
  return new TermiiProvider();
}
