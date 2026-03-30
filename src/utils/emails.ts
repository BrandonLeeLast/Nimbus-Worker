// Simple Resend email sender
export async function sendInvitationEmail(email: string, tempPassword: string, apiKey: string) {
  if (!apiKey) return;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Nimbus <onboarding@resend.dev>',
      to: email,
      subject: 'Welcome to Nimbus Tracker',
      html: `<p>You have been invited to manage Nimbus releases.</p><p>Temporary Password: <strong>${tempPassword}</strong></p><p>Please log in and reset your password immediately.</p>`
    })
  });
  
  if (!res.ok) {
    console.error('Failed to send email:', await res.text());
  }
}
