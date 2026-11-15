import nodemailer from 'nodemailer';

const appUrl = () => process.env.APP_URL || 'http://localhost:5173';

function smtpConfiguration() {
  const { SMTP_HOST, SMTP_PORT, SMTP_FROM, SMTP_USER, SMTP_PASS } = process.env;
  if ((SMTP_USER && !SMTP_PASS) || (!SMTP_USER && SMTP_PASS))
    throw new Error('SMTP_USER and SMTP_PASS must be configured together');
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM)
    return null;

  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SMTP_PORT must be a valid TCP port');

  return {
    host: SMTP_HOST,
    port,
    secure: port === 465 || process.env.SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    from: SMTP_FROM,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
}

export function hasSmtpConfiguration() {
  return Boolean(smtpConfiguration());
}

export async function sendEmail({ to, subject, text, html }) {
  const config = smtpConfiguration();
  if (!config) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('SMTP_HOST, SMTP_PORT, and SMTP_FROM must be configured to send email');
    console.info(`[DEV EMAIL] to=${to} subject=${subject}\n${text}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    connectionTimeout: config.connectionTimeout,
    greetingTimeout: config.greetingTimeout,
    socketTimeout: config.socketTimeout,
  });
  await transporter.sendMail({ from: config.from, to, subject, text, html });
}

export async function sendVerificationEmail(to, token) {
  const link = new URL('/verify-email', appUrl());
  link.searchParams.set('token', token);
  const url = link.toString();
  await sendEmail({
    to,
    subject: 'Verify your DS Agent email',
    text: `Verify your email address using this link: ${url}\nThis link expires in 24 hours.`,
    html: `<p>Verify your DS Agent email address:</p><p><a href="${url}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
  });
}

export async function sendPasswordResetEmail(to, token) {
  const link = new URL('/reset-password', appUrl());
  link.searchParams.set('token', token);
  const url = link.toString();
  await sendEmail({
    to,
    subject: 'Reset your DS Agent password',
    text: `Reset your password using this link: ${url}\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
    html: `<p>Reset your DS Agent password:</p><p><a href="${url}">Reset password</a></p><p>This link expires in 1 hour. If you did not request this, ignore this email.</p>`,
  });
}

export async function sendWorkspaceInvitationEmail(to, token, workspaceName) {
  const link = new URL('/accept-invitation', appUrl());
  link.searchParams.set('token', token);
  const url = link.toString();
  await sendEmail({
    to,
    subject: `Invitation to join ${workspaceName} on DS Agent`,
    text: `You have been invited to join ${workspaceName} on DS Agent. Sign in with this email address and accept the invitation: ${url}\nThis link expires in 7 days.`,
    html: `<p>You have been invited to join <strong>${workspaceName}</strong> on DS Agent.</p><p><a href="${url}">Accept invitation</a></p><p>This link expires in 7 days.</p>`,
  });
}
