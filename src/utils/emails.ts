import { Bindings } from '../index'

export async function sendInvitationEmail(env: Bindings, email: string, tempPass: string) {
  if (!env.RESEND_API_KEY) return;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: 'Nimbus <onboarding@resend.dev>', // Should be a verified domain in production
      to: email,
      subject: 'Welcome to Nimbus Release Tracker',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #6366f1;">Welcome to Nimbus!</h2>
          <p>You have been invited to join the Nimbus Release Tracker.</p>
          <p>Your temporary password is: <strong style="background: #f3f4f6; padding: 4px 8px; border-radius: 4px;">${tempPass}</strong></p>
          <p>Please log in and update your password immediately.</p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />
          <p style="font-size: 0.8rem; color: #6b7280;">Secure Release Management for High-Impact Teams.</p>
        </div>
      `
    })
  });

  return res;
}
