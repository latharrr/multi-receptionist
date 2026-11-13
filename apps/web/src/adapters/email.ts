// Real email over SMTP, for sign-in links, invitations and staff notices. Any provider that
// offers SMTP works; nothing here is specific to one.
import nodemailer from 'nodemailer'
import type { Notifier } from '../worker.ts'

export function smtpNotifier(url: string, from: string): Notifier & { verify(): Promise<void>; close(): void } {
  const transport = nodemailer.createTransport({ url, connectionTimeout: 10_000, socketTimeout: 15_000 })
  return {
    // Plain text only: no customer content is ever put into HTML.
    send: async (n) => void (await transport.sendMail({ from, to: n.to, subject: n.subject, text: n.body })),
    /** Opens a connection and authenticates, without sending anything. */
    verify: async () => void (await transport.verify()),
    close: () => transport.close(),
  }
}
