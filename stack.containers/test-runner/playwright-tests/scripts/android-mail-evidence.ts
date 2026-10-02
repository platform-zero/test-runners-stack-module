import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

const ca = readFileSync('/ca/caddy-ca.crt');

export async function seedInbox(
  domain: string,
  email: string,
  password: string,
  subject: string,
): Promise<void> {
  const host = `mail.${domain}`;
  const { address } = await lookup(host);
  const transport = nodemailer.createTransport({
    host: address, port: 587, secure: false, requireTLS: true,
    auth: { user: email, pass: password },
    tls: { servername: host, ca },
  });
  try {
    await transport.sendMail({
      from: email, to: email, subject,
      text: `Android native Thunderbird connectivity fixture: ${subject}`,
    });
  } finally {
    transport.close();
  }
}

async function withInbox<T>(
  domain: string,
  email: string,
  password: string,
  action: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const host = `mail.${domain}`;
  const client = new ImapFlow({
    host, port: 993, secure: true,
    auth: { user: email, pass: password },
    tls: { servername: host, ca },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try { return await action(client); }
    finally { lock.release(); }
  } finally {
    await client.logout();
  }
}

export async function inboxHasSubject(
  domain: string,
  email: string,
  password: string,
  subject: string,
): Promise<boolean> {
  return withInbox(domain, email, password, async (client) => {
    const uids = await client.search({ subject }, { uid: true });
    return Array.isArray(uids) && uids.length > 0;
  });
}

export async function removeSeededMail(
  domain: string,
  email: string,
  password: string,
  subject: string,
): Promise<void> {
  await withInbox(domain, email, password, async (client) => {
    const uids = await client.search({ subject }, { uid: true });
    if (Array.isArray(uids) && uids.length) await client.messageDelete(uids, { uid: true });
  });
}
