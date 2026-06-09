// src/services/email.service.ts
import nodemailer from 'nodemailer';

// ─── SMTP DIAGNOSTIC LOGS ───
console.log('------------------ NODEMAILER DIAGNOSTICS ------------------');
console.log('[DEBUG] SMTP_HOST:', process.env.SMTP_HOST);
console.log('[DEBUG] SMTP_PORT:', process.env.SMTP_PORT);
console.log('[DEBUG] SMTP_USER:', process.env.SMTP_USER);
console.log('[DEBUG] SMTP_PASS Length:', process.env.SMTP_PASS ? process.env.SMTP_PASS.length : 'UNDEFINED');
console.log('------------------------------------------------------------');

// Initialize the SMTP transporter using environment keys
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465', 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const emailService = {
  /**
   * Dispatches a secure, styled password reset link to the user's inbox [2].
   */
  sendPasswordResetEmail: async (to: string, resetLink: string): Promise<void> => {
    const mailOptions = {
      from: `"Ixnel Support" <${process.env.SMTP_USER}>`,
      to,
      subject: 'Reset Your Ixnel Password 🔑',
      html: `
        <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #fafafa;">
          <h2 style="color: #111827; font-weight: 800; margin-bottom: 16px;">Ixnel Animation Studio</h2>
          <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
            We received a request to reset the password for your Ixnel account. Click the button below to configure a new password. This link is time-sensitive and will expire in <strong>15 minutes</strong>.
          </p>
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${resetLink}" style="background-color: #00AAFF; color: #0a0a0a; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 24px; border-radius: 8px; display: inline-block;">
              Reset Password
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 11px; line-height: 1.4; border-t: 1px solid #e5e7eb; padding-top: 16px;">
            If you did not request a password reset, you can safely ignore this email—your account remains secure.
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
  },
};