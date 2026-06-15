import nodemailer from 'nodemailer';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

export interface IssueEmailData {
  to: string;
  issueTitle: string;
  issueUrl: string;
  issueNumber: number;
  matchedLabel: string;
  repoFullName: string;
  issueBody?: string;
  isUpdate?: boolean;
  updateCount?: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BODY_PREVIEW_CHARS = 600;

function bodySection(body: string | undefined): string {
  if (!body) return '';
  const preview = body.length > BODY_PREVIEW_CHARS
    ? escapeHtml(body.slice(0, BODY_PREVIEW_CHARS)) + '\n<em style="color:#888">… (truncated)</em>'
    : escapeHtml(body);
  return `
    <div style="margin-top:16px;">
      <div style="font-size:12px;color:#666;margin-bottom:4px;font-weight:600;">DESCRIPTION</div>
      <pre style="margin:0;padding:12px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;font-size:12px;color:#1a1a1a;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;max-height:280px;">${preview}</pre>
    </div>`;
}

export async function sendIssueNotification(data: IssueEmailData): Promise<void> {
  const subject = data.isUpdate
    ? `[Update #${data.updateCount}] Issue #${data.issueNumber}: ${data.issueTitle}`
    : `[New Issue] #${data.issueNumber}: ${data.issueTitle}`;

  const headingText = data.isUpdate
    ? `Issue Update — ${data.repoFullName}`
    : `New Matching Issue — ${data.repoFullName}`;

  const badgeColor = data.isUpdate ? '#e36209' : '#0969da';
  const badgeText = data.isUpdate ? `Update #${data.updateCount}` : 'New Issue';

  await transporter.sendMail({
    from: `"GitHub Issue Notifier" <${env.SMTP_USER}>`,
    to: data.to,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:${badgeColor};color:white;padding:4px 10px;border-radius:4px;display:inline-block;font-size:12px;font-weight:600;margin-bottom:12px;">${badgeText}</div>
        <h2 style="color:#1a1a1a;margin-top:0;">${headingText}</h2>
        <h3 style="margin:0 0 8px;">
          <a href="${data.issueUrl}" style="color:#0969da;text-decoration:none;">
            #${data.issueNumber}: ${escapeHtml(data.issueTitle)}
          </a>
        </h3>
        <p style="color:#555;margin:4px 0;">
          Label: <span style="background:#e1e4e8;border-radius:3px;padding:2px 8px;font-size:12px;">${escapeHtml(data.matchedLabel)}</span>
        </p>
        <p style="color:#555;margin:4px 0;">
          Repo: <strong>${escapeHtml(data.repoFullName)}</strong>
        </p>
        ${bodySection(data.issueBody)}
        <a href="${data.issueUrl}" style="display:inline-block;background:${badgeColor};color:white;padding:8px 16px;border-radius:6px;text-decoration:none;margin-top:16px;">
          View on GitHub
        </a>
      </div>
    `,
    text: `${headingText}\n\n#${data.issueNumber}: ${data.issueTitle}\nLabel: ${data.matchedLabel}\nRepo: ${data.repoFullName}${data.issueBody ? '\n\n' + data.issueBody.slice(0, BODY_PREVIEW_CHARS) : ''}\n\n${data.issueUrl}`,
  });

  logger.info(
    { to: data.to, issueNumber: data.issueNumber, isUpdate: data.isUpdate },
    'Notification email sent'
  );
}
